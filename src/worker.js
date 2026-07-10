// CAW relay: one Durable Object per room, hibernating WebSockets, dumb fan-out.
// Binary frames = Yjs updates (persisted + broadcast). Text frames = JSON bus.
import * as Y from 'yjs'
import html from './index.html'

export default {
  async fetch(req, env) {
    const m = new URL(req.url).pathname.match(/^\/room\/([\w-]+)$/)
    if (m) return env.ROOM.get(env.ROOM.idFromName(m[1])).fetch(req)
    return new Response(html, { headers: { 'content-type': 'text/html;charset=utf-8' } })
  },
}

export class Room {
  constructor(ctx) {
    this.ctx = ctx
  }

  async fetch(req) {
    if (req.headers.get('Upgrade') !== 'websocket')
      return new Response('expected websocket', { status: 426 })
    
    // Auth: per-room tokens
    const token = new URL(req.url).searchParams.get('token') || ''
    const storedToken = await this.ctx.storage.get('token')
    if (!storedToken) {
      await this.ctx.storage.put('token', token)
    } else if (storedToken !== token) {
      return new Response('unauthorized', { status: 401 })
    }

    const [client, server] = Object.values(new WebSocketPair())
    this.ctx.acceptWebSocket(server) // hibernation API — $0 idle
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws, msg) {
    if (typeof msg !== 'string') {
      // Yjs update: persist as a chunk, fan out. Order doesn't matter (CRDT).
      const n = (await this.ctx.storage.get('n')) || 0
      await this.ctx.storage.put({ ['u:' + String(n).padStart(8, '0')]: new Uint8Array(msg), n: n + 1 })
      if ((n + 1) % 100 === 0) await this.compact()
      this.fanout(ws, msg)
      return
    }
    const m = JSON.parse(msg)
    if (m.type === 'join') {
      ws.serializeAttachment({ agent: m.agent || 'anon', kind: m.kind === 'human' ? 'human' : 'agent' })
      for (const u of await this.updates()) ws.send(u) // catch-up
      
      // Bus history catch-up
      const history = (await this.ctx.storage.get('bus_history')) || []
      for (const h of history) ws.send(h)

      ws.send('{"type":"synced"}')
      this.broadcastPresence()
    } else {
      // bus message: stamp sender, relay to everyone else.
      const stamped = JSON.stringify({ ...m, from: ws.deserializeAttachment()?.agent, timestamp: Date.now() })
      
      // Save to bus history (keep last 100 messages)
      let history = (await this.ctx.storage.get('bus_history')) || []
      history.push(stamped)
      if (history.length > 100) history = history.slice(-100)
      await this.ctx.storage.put('bus_history', history)

      this.fanout(ws, stamped)
    }
  }

  async webSocketClose() {
    this.broadcastPresence()
  }

  peers() {
    return this.ctx.getWebSockets().map((w) => w.deserializeAttachment()).filter((a) => a?.agent)
  }

  broadcastPresence() {
    const msg = JSON.stringify({ type: 'presence', peers: this.peers() })
    for (const w of this.ctx.getWebSockets()) try { w.send(msg) } catch {}
  }

  fanout(sender, msg) {
    for (const w of this.ctx.getWebSockets()) if (w !== sender) try { w.send(msg) } catch {}
  }

  async updates() {
    return [...(await this.ctx.storage.list({ prefix: 'u:' })).values()]
  }

  async compact() {
    // ponytail: merged doc must stay under the 128KB per-value limit; shard to R2 if a room outgrows it
    const map = await this.ctx.storage.list({ prefix: 'u:' })
    const merged = Y.mergeUpdates([...map.values()])
    const keys = [...map.keys()]
    for (let i = 0; i < keys.length; i += 128) await this.ctx.storage.delete(keys.slice(i, i + 128))
    const n = (await this.ctx.storage.get('n')) || 0
    await this.ctx.storage.put('u:' + String(n).padStart(8, '0'), merged)
  }
}
