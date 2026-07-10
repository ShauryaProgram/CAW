#!/usr/bin/env node
// CAW MCP bridge: gives any MCP-client agent (Claude Code, Codex, OpenCode, Cursor)
// tools to read/write the shared CRDT room and publish/subscribe on the bus.
// Env: CAW_URL (default ws://localhost:8787), CAW_ROOM (default lobby), CAW_AGENT.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import WebSocket from 'ws'
import * as Y from 'yjs'
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

const URL_ = process.env.CAW_URL || 'ws://localhost:8787'
const ROOM = process.env.CAW_ROOM || 'lobby'
const AGENT = process.env.CAW_AGENT || 'agent-' + process.pid
const TOKEN = process.env.CAW_TOKEN || ''
const DIR = process.env.CAW_DIR // shared project directory (a git repo) agents work in

const ydoc = new Y.Doc()
const ytext = ydoc.getText('doc')
const ytasks = ydoc.getMap('tasks')
const yprops = ydoc.getMap('proposals')
const yquestions = ydoc.getMap('questions')

// consensus: rejected if anyone voted no; approved when every voter (humans present
// at propose time) voted yes; if no humans were present then, one human yes approves.
function proposalStatus(p) {
  const votes = p.votes || {}
  if (Object.values(votes).includes(false)) return 'rejected'
  if (p.voters?.length) return p.voters.every((v) => votes[v] === true) ? 'approved' : 'pending'
  return Object.values(votes).includes(true) ? 'approved' : 'pending'
}
let sock = null
let peers = []
const inbox = [] // buffered bus messages since connect; drained by caw_read_messages

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${URL_}/room/${ROOM}?token=${encodeURIComponent(TOKEN)}`)
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', agent: AGENT })))
    ws.on('message', (data, isBinary) => {
      if (isBinary) return Y.applyUpdate(ydoc, new Uint8Array(data), 'remote')
      const m = JSON.parse(data.toString())
      if (m.type === 'synced') { sock = ws; resolve() }
      else if (m.type === 'presence') peers = m.peers
      else { inbox.push(m); if (inbox.length > 500) inbox.shift() }
    })
    ws.on('error', reject)
    ws.on('close', () => { sock = null })
  })
}
async function ensure() { if (!sock) await connect() } // reconnects lazily on next tool call
ydoc.on('update', (u, origin) => { if (origin !== 'remote' && sock?.readyState === 1) sock.send(u) })

const text = (s) => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) }] })
const server = new McpServer({ name: 'caw', version: '0.1.0' })

server.registerTool('caw_status', {
  description: 'Room name, your agent id, and who else is connected to this CAW room.',
}, async () => { await ensure(); return text({ room: ROOM, agent: AGENT, peers }) })

server.registerTool('caw_read_doc', {
  description: 'Read the shared collaborative document (scratchpad/plan) for the room.',
}, async () => { await ensure(); return text(ytext.toString() || '(empty)') })

server.registerTool('caw_write_doc', {
  description: 'Write to the shared document. append=true adds to the end, otherwise replaces it.',
  inputSchema: { content: z.string(), append: z.boolean().optional() },
}, async ({ content, append }) => {
  await ensure()
  ydoc.transact(() => {
    if (!append) ytext.delete(0, ytext.length)
    ytext.insert(ytext.length, append && ytext.length ? '\n' + content : content)
  })
  return text('ok')
})

server.registerTool('caw_list_tasks', {
  description: 'List all tasks in the shared queue with id, title, status (submitted|working|input-required|completed|failed) and owner.',
}, async () => { await ensure(); return text(Object.fromEntries(ytasks.entries())) })

server.registerTool('caw_add_task', {
  description: 'Add a task to the shared queue (status=submitted). Returns its id.',
  inputSchema: { title: z.string() },
}, async ({ title }) => {
  await ensure()
  const id = Math.random().toString(36).slice(2, 10)
  ytasks.set(id, { title, status: 'submitted', owner: null })
  return text({ id })
})

server.registerTool('caw_claim_task', {
  description: 'Claim a submitted task: sets status=working and owner=you. Fails if already claimed.',
  inputSchema: { id: z.string() },
}, async ({ id }) => {
  await ensure()
  const t = ytasks.get(id)
  if (!t) return text(`no task ${id}`)
  if (t.owner && t.owner !== AGENT) return text(`already claimed by ${t.owner}`)
  ytasks.set(id, { ...t, status: 'working', owner: AGENT })
  return text('claimed')
})

server.registerTool('caw_update_task', {
  description: 'Update a task status. Use input-required to request a phase-gate approval, completed/failed to finish.',
  inputSchema: { id: z.string(), status: z.enum(['submitted', 'working', 'input-required', 'completed', 'failed']), note: z.string().optional() },
}, async ({ id, status, note }) => {
  await ensure()
  const t = ytasks.get(id)
  if (!t) return text(`no task ${id}`)
  ytasks.set(id, { ...t, status, note })
  sock.send(JSON.stringify({ type: 'bus', topic: 'task.' + status, data: { id, title: t.title, note } }))
  return text('ok')
})

server.registerTool('caw_publish', {
  description: 'Broadcast a message on the coordination bus. Topics by convention: intent.* (about to touch X), task.*, gate.*, chat.',
  inputSchema: { topic: z.string(), data: z.string() },
}, async ({ topic, data }) => {
  await ensure()
  sock.send(JSON.stringify({ type: 'bus', topic, data }))
  return text('published')
})

server.registerTool('caw_read_messages', {
  description: 'Drain bus messages received from other agents/humans since the last call. Call periodically to stay coordinated.',
}, async () => { await ensure(); return text(inbox.splice(0)) })

server.registerTool('caw_propose', {
  description: 'Propose a plan of work to the room. All humans present must vote yes before you start. Returns the proposal id — poll caw_list_proposals until status=approved, then add tasks and begin.',
  inputSchema: { title: z.string(), description: z.string() },
}, async ({ title, description }) => {
  await ensure()
  const id = Math.random().toString(36).slice(2, 10)
  const voters = peers.filter((p) => p.kind === 'human').map((p) => p.agent)
  yprops.set(id, { title, description, proposedBy: AGENT, voters, votes: {} })
  sock.send(JSON.stringify({ type: 'bus', topic: 'gate.proposal', data: { id, title } }))
  return text({ id, voters })
})

server.registerTool('caw_list_proposals', {
  description: 'List proposals with vote tallies and derived status (pending|approved|rejected).',
}, async () => {
  await ensure()
  return text(Object.fromEntries([...yprops.entries()].map(([id, p]) => [id, { ...p, status: proposalStatus(p) }])))
})

server.registerTool('caw_vote', {
  description: 'Vote yes/no on a proposal.',
  inputSchema: { id: z.string(), yes: z.boolean() },
}, async ({ id, yes }) => {
  await ensure()
  const p = yprops.get(id)
  if (!p) return text(`no proposal ${id}`)
  yprops.set(id, { ...p, votes: { ...p.votes, [AGENT]: yes } })
  return text({ status: proposalStatus(yprops.get(id)) })
})

server.registerTool('caw_ask_human', {
  description: 'Ask the humans in the room a question about your work (clarification, decision, approval). Returns a question id — poll caw_check_answer until answered. Keep working on other things while you wait.',
  inputSchema: { question: z.string() },
}, async ({ question }) => {
  await ensure()
  const id = Math.random().toString(36).slice(2, 10)
  yquestions.set(id, { question, from: AGENT, answer: null, answeredBy: null })
  sock.send(JSON.stringify({ type: 'bus', topic: 'gate.question', data: { id, question } }))
  return text({ id })
})

server.registerTool('caw_check_answer', {
  description: 'Check whether a question you asked has been answered by a human.',
  inputSchema: { id: z.string() },
}, async ({ id }) => { await ensure(); return text(yquestions.get(id) || `no question ${id}`) })

server.registerTool('caw_stats', {
  description: 'Room stats: who is connected (humans/agents), who is working on what, task counts by status, open gates, pending proposals, unanswered questions.',
}, async () => {
  await ensure()
  const tasks = [...ytasks.entries()]
  const byStatus = {}
  for (const [, t] of tasks) byStatus[t.status] = (byStatus[t.status] || 0) + 1
  return text({
    room: ROOM,
    humans: peers.filter((p) => p.kind === 'human').map((p) => p.agent),
    agents: peers.filter((p) => p.kind === 'agent').map((p) => p.agent),
    tasksByStatus: byStatus,
    working: tasks.filter(([, t]) => t.status === 'working').map(([id, t]) => ({ id, title: t.title, owner: t.owner })),
    gatesAwaitingApproval: tasks.filter(([, t]) => t.status === 'input-required').map(([id, t]) => ({ id, title: t.title, owner: t.owner, note: t.note })),
    pendingProposals: [...yprops.entries()].filter(([, p]) => proposalStatus(p) === 'pending').map(([id, p]) => ({ id, title: p.title })),
    unansweredQuestions: [...yquestions.entries()].filter(([, q]) => !q.answer).map(([id, q]) => ({ id, from: q.from, question: q.question })),
  })
})

server.registerTool('caw_worktree', {
  description: 'Provision your own isolated git worktree (branch cas/<you>) inside the shared project directory (CAW_DIR). Do all file work in the returned path; merge via normal git when done.',
}, async () => {
  if (!DIR) return text('CAW_DIR is not set for this bridge — ask the human to configure it')
  const wt = path.join(path.dirname(DIR), path.basename(DIR) + '-' + AGENT)
  if (!existsSync(wt))
    execSync(`git worktree add "${wt}" -b "cas/${AGENT}"`, { cwd: DIR, stdio: 'pipe' })
  return text({ path: wt, branch: 'cas/' + AGENT, sharedRepo: DIR })
})

await server.connect(new StdioServerTransport())
