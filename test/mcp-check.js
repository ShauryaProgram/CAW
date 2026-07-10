// Drive the CAW MCP bridge as a real MCP client; verify tools hit the live room.
// Also simulates a human peer to exercise consensus, questions, and stats.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import WebSocket from 'ws'
import * as Y from 'yjs'
import assert from 'node:assert'
import { execSync } from 'node:child_process'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const ROOM = 'mcp-check-' + Math.random().toString(36).slice(2, 8)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// a throwaway git repo for the worktree tool
const repo = mkdtempSync(path.join(tmpdir(), 'caw-repo-'))
execSync('git init -q && git commit -q --allow-empty -m init', { cwd: repo })

// simulated human peer (what the CLI / web UI does)
const human = await new Promise((resolve, reject) => {
  const ydoc = new Y.Doc()
  const ws = new WebSocket(`ws://localhost:8787/room/${ROOM}`)
  ws.on('open', () => ws.send(JSON.stringify({ type: 'join', agent: 'shaurya', kind: 'human' })))
  ws.on('message', (data, isBinary) => {
    if (isBinary) return Y.applyUpdate(ydoc, new Uint8Array(data), 'remote')
    if (JSON.parse(data.toString()).type === 'synced') resolve({ ydoc, ws })
  })
  ws.on('error', reject)
  ydoc.on('update', (u, o) => { if (o !== 'remote' && ws.readyState === 1) ws.send(u) })
})

const client = new Client({ name: 'check', version: '0.0.0' })
await client.connect(new StdioClientTransport({
  command: 'node',
  args: ['/Users/shauryabhushan/Documents/caw/bridge/caw-mcp.js'],
  env: { ...process.env, CAW_URL: 'ws://localhost:8787', CAW_ROOM: ROOM, CAW_AGENT: 'claude-a', CAW_DIR: repo },
}))
const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).content[0].text
const callJ = async (name, args) => JSON.parse(await call(name, args))

console.log('tools:', (await client.listTools()).tools.map((t) => t.name).join(', '))

// tasks + doc (regression from v1)
const { id } = await callJ('caw_add_task', { title: 'ship the oauth middleware' })
await call('caw_claim_task', { id })
const list = await callJ('caw_list_tasks')
assert.equal(list[id].status, 'working')
assert.equal(list[id].owner, 'claude-a')
await call('caw_write_doc', { content: 'plan: 1) middleware 2) tests', append: false })
assert.equal(await call('caw_read_doc'), 'plan: 1) middleware 2) tests')

// consensus: agent proposes, human present → human must vote, then approved
const prop = await callJ('caw_propose', { title: 'build auth system', description: 'oauth + sessions' })
assert.deepEqual(prop.voters, ['shaurya'], 'voters should be the humans present')
let props = await callJ('caw_list_proposals')
assert.equal(props[prop.id].status, 'pending')
const p = human.ydoc.getMap('proposals').get(prop.id) // human votes yes (CLI/UI path)
human.ydoc.getMap('proposals').set(prop.id, { ...p, votes: { ...p.votes, shaurya: true } })
await sleep(400)
props = await callJ('caw_list_proposals')
assert.equal(props[prop.id].status, 'approved', 'all-humans-yes should approve')

// questions: agent asks, human answers, agent sees it
const q = await callJ('caw_ask_human', { question: 'postgres or sqlite for sessions?' })
await sleep(400)
const qmap = human.ydoc.getMap('questions')
qmap.set(q.id, { ...qmap.get(q.id), answer: 'sqlite', answeredBy: 'shaurya' })
await sleep(400)
const ans = await callJ('caw_check_answer', { id: q.id })
assert.equal(ans.answer, 'sqlite')

// stats: who's on what
const stats = await callJ('caw_stats')
assert.ok(stats.humans.includes('shaurya'))
assert.ok(stats.agents.includes('claude-a'))
assert.equal(stats.working[0].owner, 'claude-a')
assert.equal(stats.tasksByStatus.working, 1)

// worktree provisioning in the shared project dir
const wt = await callJ('caw_worktree')
assert.ok(existsSync(wt.path), 'worktree dir should exist')
assert.equal(wt.branch, 'cas/claude-a')
assert.equal(execSync('git branch --show-current', { cwd: wt.path }).toString().trim(), 'cas/claude-a')

await call('caw_publish', { topic: 'intent.edit', data: 'touching src/auth.ts' })
console.log('mcp bridge: all assertions passed')
human.ws.close()
await client.close()
process.exit(0)
