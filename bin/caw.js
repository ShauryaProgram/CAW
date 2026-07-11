#!/usr/bin/env node
// Headless human interface to a CAW room — everything the web UI does, from a terminal.
// Usage: caw [--url ws://…] [--room name] [--as you] [--token pass] <command>
//   init                       auto-inject MCP config into your IDE (Cursor, OpenCode, Claude)
//   status                     who's in the room
//   doc                        print the shared doc
//   doc set "text"             replace the shared doc
//   doc append "text"          append to the shared doc
//   tasks                      list tasks
//   add "title"                add a task
//   claim <id>                 claim a task
//   set <id> <status> [note]   set task status (submitted|working|input-required|completed|failed)
//   approve <id>               approve a phase gate (input-required → working)
//   pub <topic> <message>      publish on the bus
//   propose "title" ["desc"]   propose work for the room to agree on
//   proposals                  list proposals with votes and status
//   vote <id> yes|no           vote on a proposal
//   questions                  list questions agents have asked
//   answer <id> "text"         answer an agent's question
//   stats                      progress: who's on what, counts, open gates
//   watch                      live-tail presence, bus, and task changes (Ctrl-C to stop)
//   watchdog                   auto-recover stalled tasks if agents go silent
//   auto-approve [cmd]         auto-run tests on phase gates (e.g. `npm test`)
//   sync-tasks                 auto-extract bullet points under '## Tasks' to the task queue
import WebSocket from 'ws'
import * as Y from 'yjs'

const args = process.argv.slice(2)
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : dflt }
const URL_ = opt('--url', process.env.CAW_URL || 'ws://localhost:8787')
const ROOM = opt('--room', process.env.CAW_ROOM || 'lobby')
const AGENT = opt('--as', process.env.CAW_AGENT || process.env.USER || 'human')
const TOKEN = opt('--token', process.env.CAW_TOKEN || '')
const [cmd, ...rest] = args

const ydoc = new Y.Doc()
const ytext = ydoc.getText('doc')
const ytasks = ydoc.getMap('tasks')
const yprops = ydoc.getMap('proposals')
const yquestions = ydoc.getMap('questions')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function proposalStatus(p) {
  const votes = p.votes || {}
  if (Object.values(votes).includes(false)) return 'rejected'
  if (p.voters?.length) return p.voters.every((v) => votes[v] === true) ? 'approved' : 'pending'
  return Object.values(votes).includes(true) ? 'approved' : 'pending'
}
const fmtPeer = (p) => (p.kind === 'agent' ? '🤖' : '👤') + p.agent

let peers = []
const ws = new WebSocket(`${URL_}/room/${ROOM}?token=${encodeURIComponent(TOKEN)}`)
const synced = new Promise((resolve, reject) => {
  ws.on('open', () => ws.send(JSON.stringify({ type: 'join', agent: AGENT, kind: 'human' })))
  ws.on('error', reject)
  ws.on('message', (data, isBinary) => {
    if (isBinary) return Y.applyUpdate(ydoc, new Uint8Array(data), 'remote')
    const m = JSON.parse(data.toString())
    if (m.type === 'synced') resolve()
    else if (m.type === 'presence') {
      peers = m.peers
      if (cmd === 'watch') console.log(`[presence] ${peers.map(fmtPeer).join(', ')}`)
    } else if (cmd === 'watch') console.log(`[${m.topic}] ${m.from}: ${JSON.stringify(m.data)}`)
  })
})
ydoc.on('update', (u, o) => { if (o !== 'remote' && ws.readyState === 1) ws.send(u) })
await synced

const printTasks = () => {
  for (const [id, t] of ytasks.entries())
    console.log(`${id}  [${t.status}]${t.owner ? ' @' + t.owner : ''}  ${t.title}${t.note ? '  — ' + t.note : ''}`)
  if (!ytasks.size) console.log('(no tasks)')
}

switch (cmd) {
  case 'init': {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const bridgePath = path.resolve('bridge/caw-mcp.js')
    const env = { CAW_URL: URL_, CAW_ROOM: ROOM, CAW_AGENT: AGENT }
    if (TOKEN) env.CAW_TOKEN = TOKEN
    
    const configs = [
      { file: '.cursor/mcp.json', type: 'standard' },
      { file: '.opencode/opencode.json', type: 'opencode' },
      { file: path.join(process.env.HOME || '', '.config/opencode/opencode.json'), type: 'opencode' },
      { file: path.join(process.env.HOME || '', '.claude.json'), type: 'standard' },
      { file: path.join(process.env.HOME || '', '.codex/config.toml'), type: 'toml' },
      { file: path.join(process.env.HOME || '', '.codeium/windsurf/mcp_config.json'), type: 'standard' }
    ]

    let updated = 0
    for (const { file, type } of configs) {
      if (!fs.existsSync(file)) {
        if (file === '.cursor/mcp.json') {
          fs.mkdirSync('.cursor', { recursive: true })
          fs.writeFileSync(file, JSON.stringify({ mcpServers: {} }))
        } else {
          continue
        }
      }
      
      try {
        if (type === 'standard') {
          const cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
          cfg.mcpServers = cfg.mcpServers || {}
          cfg.mcpServers.caw = { command: 'node', args: [bridgePath], env }
          fs.writeFileSync(file, JSON.stringify(cfg, null, 2))
          console.log(`✅ Updated ${file}`)
          updated++
        } else if (type === 'opencode') {
          const cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
          cfg.mcp = cfg.mcp || {}
          cfg.mcp.caw = { type: 'local', command: ['node', bridgePath], env }
          fs.writeFileSync(file, JSON.stringify(cfg, null, 2))
          console.log(`✅ Updated ${file}`)
          updated++
        } else if (type === 'toml') {
          const tomlAppend = `\n[mcp_servers.caw]\ncommand = "node"\nargs = ["${bridgePath}"]\n[mcp_servers.caw.env]\nCAW_URL = "${URL_}"\nCAW_ROOM = "${ROOM}"\nCAW_AGENT = "${AGENT}"\n`
          let content = fs.readFileSync(file, 'utf8')
          if (!content.includes('[mcp_servers.caw]')) {
            fs.appendFileSync(file, tomlAppend)
            console.log(`✅ Updated ${file}`)
            updated++
          }
        }
      } catch (e) {
        console.error(`❌ Failed to update ${file}: ${e.message}`)
      }
    }
    if (updated > 0) console.log('MCP config injected! Please restart your AI agent to apply.')
    else console.log('No supported IDE configs found. You may need to configure MCP manually.')
    break
  }
  case 'watchdog': {
    console.log(`watching for inactive agents in ${ROOM} @ ${URL_}... (Ctrl-C to stop)`)
    const TIMEOUT_MS = 60000;
    const lastSeen = new Map()

    ws.on('message', (data, isBinary) => {
      if (isBinary) return
      const m = JSON.parse(data.toString())
      if (m.type === 'bus' && m.from) {
        lastSeen.set(m.from, Date.now())
      }
    })

    setInterval(() => {
      const now = Date.now()
      let changed = false
      ydoc.transact(() => {
        for (const [id, t] of ytasks.entries()) {
          if (t.status === 'working' && t.owner) {
            const last = lastSeen.get(t.owner) || now
            if (now - last > TIMEOUT_MS) {
              console.log(`[watchdog] Agent ${t.owner} timed out. Re-queueing task ${id}...`)
              ytasks.set(id, { ...t, status: 'submitted', owner: null, note: `auto-requeued (agent ${t.owner} timed out)` })
              changed = true
              ws.send(JSON.stringify({ type: 'bus', topic: 'task.requeued', data: { id, title: t.title, agent: t.owner } }))
              lastSeen.delete(t.owner)
            }
          }
        }
      })
    }, 10000)
    
    await new Promise(() => {})
    break
  }
  case 'status':
    await sleep(300) // peers arrive via the presence broadcast triggered by our own join
    console.log(`room: ${ROOM} @ ${URL_}\npeers: ${peers.map(fmtPeer).join(', ') || '(none)'}`)
    break
  case 'doc':
    if (rest[0] === 'set') ydoc.transact(() => { ytext.delete(0, ytext.length); ytext.insert(0, rest[1] || '') })
    else if (rest[0] === 'append') ytext.insert(ytext.length, (ytext.length ? '\n' : '') + (rest[1] || ''))
    else console.log(ytext.toString() || '(empty)')
    break
  case 'tasks': printTasks(); break
  case 'add': {
    const id = Math.random().toString(36).slice(2, 10)
    ytasks.set(id, { title: rest.join(' '), status: 'submitted', owner: null })
    console.log(id)
    break
  }
  case 'claim': {
    const t = ytasks.get(rest[0])
    if (!t) { console.error('no such task'); process.exit(1) }
    ytasks.set(rest[0], { ...t, status: 'working', owner: AGENT })
    break
  }
  case 'set': case 'approve': {
    const [id, status, ...note] = cmd === 'approve' ? [rest[0], 'working'] : rest
    const t = ytasks.get(id)
    if (!t) { console.error('no such task'); process.exit(1) }
    ytasks.set(id, { ...t, status, note: note?.join(' ') || t.note })
    ws.send(JSON.stringify({ type: 'bus', topic: 'task.' + status, data: { id, title: t.title } }))
    break
  }
  case 'pub':
    ws.send(JSON.stringify({ type: 'bus', topic: rest[0], data: rest.slice(1).join(' ') }))
    break
  case 'propose': {
    const id = Math.random().toString(36).slice(2, 10)
    const voters = peers.filter((p) => p.kind === 'human').map((p) => p.agent)
    yprops.set(id, { title: rest[0], description: rest[1] || '', proposedBy: AGENT, voters, votes: {} })
    ws.send(JSON.stringify({ type: 'bus', topic: 'gate.proposal', data: { id, title: rest[0] } }))
    console.log(id)
    break
  }
  case 'proposals':
    for (const [id, p] of yprops.entries())
      console.log(`${id}  [${proposalStatus(p)}]  ${p.title}  (by ${p.proposedBy}; votes: ${Object.entries(p.votes || {}).map(([w, v]) => `${w}=${v ? 'yes' : 'no'}`).join(', ') || 'none'}; needs: ${p.voters?.join(', ') || 'any human'})`)
    if (!yprops.size) console.log('(no proposals)')
    break
  case 'vote': {
    const p = yprops.get(rest[0])
    if (!p) { console.error('no such proposal'); process.exit(1) }
    yprops.set(rest[0], { ...p, votes: { ...p.votes, [AGENT]: rest[1] !== 'no' } })
    console.log(proposalStatus(yprops.get(rest[0])))
    break
  }
  case 'questions':
    for (const [id, q] of yquestions.entries())
      console.log(`${id}  ${q.answer ? '[answered by ' + q.answeredBy + ']' : '[OPEN]'}  ${q.from} asks: ${q.question}${q.answer ? '\n          ↳ ' + q.answer : ''}`)
    if (!yquestions.size) console.log('(no questions)')
    break
  case 'answer': {
    const q = yquestions.get(rest[0])
    if (!q) { console.error('no such question'); process.exit(1) }
    yquestions.set(rest[0], { ...q, answer: rest.slice(1).join(' '), answeredBy: AGENT })
    ws.send(JSON.stringify({ type: 'bus', topic: 'gate.answer', data: { id: rest[0] } }))
    break
  }
  case 'stats': {
    await sleep(300)
    const tasks = [...ytasks.entries()]
    const by = {}
    for (const [, t] of tasks) by[t.status] = (by[t.status] || 0) + 1
    console.log(`room: ${ROOM}`)
    console.log(`humans: ${peers.filter((p) => p.kind === 'human').map((p) => p.agent).join(', ') || '(none)'}`)
    console.log(`agents: ${peers.filter((p) => p.kind === 'agent').map((p) => p.agent).join(', ') || '(none)'}`)
    console.log(`tasks: ${Object.entries(by).map(([s, n]) => `${s}=${n}`).join(' ') || 'none'}`)
    for (const [id, t] of tasks.filter(([, t]) => t.status === 'working')) console.log(`  working: ${t.owner} → ${t.title} (${id})`)
    for (const [id, t] of tasks.filter(([, t]) => t.status === 'input-required')) console.log(`  GATE: ${t.title} (${id})${t.note ? ' — ' + t.note : ''}`)
    for (const [id, p] of [...yprops.entries()].filter(([, p]) => proposalStatus(p) === 'pending')) console.log(`  pending proposal: ${p.title} (${id})`)
    for (const [id, q] of [...yquestions.entries()].filter(([, q]) => !q.answer)) console.log(`  open question from ${q.from}: ${q.question} (${id})`)
    break
  }
  case 'auto-approve': {
    const execSync = (await import('node:child_process')).execSync
    const runCmd = rest.join(' ') || 'npm test'
    console.log(`watching for 'input-required' tasks to auto-approve via: ${runCmd}`)
    ytasks.observeDeep(() => {
      ydoc.transact(() => {
        for (const [id, t] of ytasks.entries()) {
          if (t.status === 'input-required') {
            console.log(`\n[auto-approve] Task ${id} (${t.title}) needs approval. Running tests...`)
            try {
              execSync(runCmd, { stdio: 'inherit' })
              console.log(`[auto-approve] ✅ Tests passed! Auto-approving task ${id}.`)
              ytasks.set(id, { ...t, status: 'completed', note: 'auto-approved by CI' })
              ws.send(JSON.stringify({ type: 'bus', topic: 'task.completed', data: { id, title: t.title, note: 'auto-approved' } }))
            } catch (err) {
              console.log(`[auto-approve] ❌ Tests failed. Rejecting task ${id}.`)
              ytasks.set(id, { ...t, status: 'failed', note: 'auto-rejected by CI failure' })
              ws.send(JSON.stringify({ type: 'bus', topic: 'task.failed', data: { id, title: t.title, note: 'auto-rejected' } }))
            }
          }
        }
      })
    })
    await new Promise(() => {})
    break
  }
  case 'sync-tasks': {
    console.log(`watching shared doc for '## Tasks' to auto-orchestrate...`)
    let lastDoc = ''
    ytext.observe(() => {
      const currentDoc = ytext.toString()
      if (currentDoc === lastDoc) return
      lastDoc = currentDoc
      
      const lines = currentDoc.split('\n')
      let inTasks = false
      const newTasks = []
      for (const line of lines) {
        if (line.trim().toLowerCase() === '## tasks') { inTasks = true; continue }
        if (inTasks && line.startsWith('## ')) { inTasks = false; continue }
        if (inTasks) {
          const match = line.match(/^[-*]\s+(.+)/)
          if (match) newTasks.push(match[1].trim())
        }
      }
      
      if (newTasks.length > 0) {
        ydoc.transact(() => {
          const existingTitles = new Set([...ytasks.values()].map(t => t.title))
          for (const title of newTasks) {
            if (!existingTitles.has(title)) {
              const id = Math.random().toString(36).slice(2, 10)
              ytasks.set(id, { title, status: 'submitted', owner: null, note: 'auto-extracted from doc' })
              console.log(`[sync-tasks] Auto-created task: ${title}`)
            }
          }
        })
      }
    })
    await new Promise(() => {})
    break
  }
  case 'watch':
    console.log(`watching ${ROOM} @ ${URL_} — Ctrl-C to stop`)
    ytasks.observeDeep(() => { console.log('[tasks]'); printTasks() })
    await new Promise(() => {}) // run until killed
  default:
    if (cmd !== 'status' && cmd !== 'watch') { console.error('usage: see header of bin/caw.js'); process.exit(cmd ? 1 : 0) }
}

await sleep(300) // let pending Yjs updates flush before closing
ws.close()
process.exit(0)
