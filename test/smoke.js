// Smoke test: two clients join a room, CRDT state converges, bus relays.
// Requires `npm run dev` (wrangler dev on :8787) to be running.
import WebSocket from 'ws'
import * as Y from 'yjs'
import assert from 'node:assert'

const ROOM = 'smoke-' + Math.random().toString(36).slice(2, 8)
const TOKEN = 'secret123'

function client(agent) {
  const ydoc = new Y.Doc()
  const inbox = []
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:8787/room/${ROOM}?token=${TOKEN}`)
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', agent })))
    ws.on('message', (data, isBinary) => {
      if (isBinary) return Y.applyUpdate(ydoc, new Uint8Array(data), 'remote')
      const m = JSON.parse(data.toString())
      if (m.type === 'synced') resolve({ ydoc, ws, inbox })
      else if (m.type !== 'presence') inbox.push(m)
    })
    ws.on('error', reject)
    ydoc.on('update', (u, o) => { if (o !== 'remote' && ws.readyState === 1) ws.send(u) })
  })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const a = await client('alice')
const b = await client('bob')

// A adds a task, B edits the doc — both must converge
a.ydoc.getMap('tasks').set('t1', { title: 'write oauth middleware', status: 'submitted', owner: null })
b.ydoc.getText('doc').insert(0, 'hello from bob')
a.ws.send(JSON.stringify({ type: 'bus', topic: 'intent.edit', data: 'touching auth.ts' }))
await sleep(500)

assert.equal(b.ydoc.getMap('tasks').get('t1').title, 'write oauth middleware', 'task did not sync A→B')
assert.equal(a.ydoc.getText('doc').toString(), 'hello from bob', 'doc did not sync B→A')
const bus = b.inbox.find((m) => m.topic === 'intent.edit')
assert.ok(bus && bus.from === 'alice', 'bus message not relayed with sender stamp')

// Late joiner catches up from persisted state
const c = await client('carol')
await sleep(200)
assert.equal(c.ydoc.getText('doc').toString(), 'hello from bob', 'late joiner did not catch up')
assert.ok(c.ydoc.getMap('tasks').get('t1'), 'late joiner missing task')

a.ws.close(); b.ws.close(); c.ws.close()
console.log('smoke: all assertions passed')
process.exit(0)
