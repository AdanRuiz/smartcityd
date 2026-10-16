import { DurableObject } from 'cloudflare:workers'
import { acceptEvent, isNew, type AcceptResult } from './accept.js'
import { readConfig, type Config } from './config.js'
import type { NostrEvent } from './event.js'
import { MAX_FILTERS, MAX_SUBSCRIPTIONS, matchFilter, parseFilter, type Filter } from './filter.js'
import { RateLimiter } from './ratelimit.js'
import { Store, queryAll } from './store.js'
import type { Env } from './env.js'

interface Attachment {
  cid: string
  ip: string
}

export interface Counters {
  accepted: number
  stored: number
  rowsWritten: number
  connections: number
  subscriptions: number
}

/** Message the Worker sends after accepting an event over HTTP. */
export interface Broadcast {
  event: NostrEvent
  status: Extract<AcceptResult, { ok: true }>['status']
  rowsWritten: number
}

const SUB_PREFIX = 's:'
const MAX_FRAME_CHARS = 2 * 64 * 1024

const seconds = () => Math.floor(Date.now() / 1000)

/**
 * The single hub of v1 (docs/spec/07, Q-5): holds the WebSockets with the hibernation API, keeps the
 * subscriptions and fans out new events. Subscriptions live in Durable Object storage, not in the socket
 * attachment, so they survive hibernation.
 */
export class Hub extends DurableObject<Env> {
  private readonly config: Config
  private readonly store: Store
  private readonly limiter = new RateLimiter()
  private subs: Map<string, Map<string, Filter[]>> | null = null
  private readonly counters = { accepted: 0, stored: 0, rowsWritten: 0 }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.config = readConfig(env)
    this.store = new Store(env.DB)
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/broadcast' && request.method === 'POST') {
      const message = await request.json<Broadcast>()
      this.count(message)
      await this.fanOut(message.event)
      return new Response(null, { status: 204 })
    }
    if (url.pathname === '/counters') return Response.json(await this.snapshotCounters())
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('expected websocket', { status: 426 })

    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    this.ctx.acceptWebSocket(server)
    const attachment: Attachment = { cid: crypto.randomUUID(), ip: request.headers.get('CF-Connecting-IP') ?? 'unknown' }
    server.serializeAttachment(attachment)
    return new Response(null, { status: 101, webSocket: client })
  }

  override async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const send = (message: unknown[]) => ws.send(JSON.stringify(message))
    if (typeof data !== 'string') return send(['NOTICE', 'invalid: binary messages are not supported'])
    if (data.length > MAX_FRAME_CHARS) return send(['NOTICE', 'invalid: message too large'])
    let message: unknown
    try {
      message = JSON.parse(data)
    } catch {
      return send(['NOTICE', 'invalid: message is not JSON'])
    }
    if (!Array.isArray(message) || typeof message[0] !== 'string') return send(['NOTICE', 'invalid: expected a JSON array'])

    const { cid, ip } = ws.deserializeAttachment() as Attachment
    switch (message[0]) {
      case 'EVENT':
        return this.onEvent(message[1], ip, send)
      case 'REQ':
        return this.onReq(cid, message.slice(1), send)
      case 'CLOSE':
        if (typeof message[1] === 'string') await this.removeSub(cid, message[1])
        return
      default:
        return send(['NOTICE', `invalid: unknown message type ${message[0]}`])
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    await this.dropConnection(ws)
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.dropConnection(ws)
  }

  private async onEvent(raw: unknown, ip: string, send: (m: unknown[]) => void): Promise<void> {
    let result: AcceptResult
    try {
      result = await acceptEvent(raw, ip, { store: this.store, config: this.config, limiter: this.limiter, now: seconds })
    } catch (error) {
      console.error('accept failed', error)
      result = { ok: false, id: (raw as { id?: string } | null)?.id ?? '', message: 'error: could not store the event' }
    }
    send(['OK', result.ok ? result.event.id : result.id, result.ok, result.message])
    if (isNew(result)) {
      this.count(result)
      await this.fanOut(result.event)
    }
  }

  private async onReq(cid: string, args: unknown[], send: (m: unknown[]) => void): Promise<void> {
    const [subId, ...rawFilters] = args
    if (typeof subId !== 'string' || subId.length === 0 || subId.length > 64) {
      return send(['NOTICE', 'invalid: subscription id must be a string of 1-64 characters'])
    }
    if (rawFilters.length === 0 || rawFilters.length > MAX_FILTERS) {
      return send(['CLOSED', subId, `invalid: between 1 and ${MAX_FILTERS} filters per subscription`])
    }
    const filters: Filter[] = []
    for (const raw of rawFilters) {
      const filter = parseFilter(raw)
      if (typeof filter === 'string') return send(['CLOSED', subId, filter.startsWith('unsupported:') ? filter : `invalid: ${filter}`])
      filters.push(filter)
    }
    const subs = await this.subscriptions()
    const own = subs.get(cid) ?? new Map<string, Filter[]>()
    if (!own.has(subId) && own.size >= MAX_SUBSCRIPTIONS) {
      return send(['CLOSED', subId, `blocked: at most ${MAX_SUBSCRIPTIONS} subscriptions per connection`])
    }
    // Registered before querying so nothing published meanwhile is missed; clients deduplicate (DATA-6).
    own.set(subId, filters)
    subs.set(cid, own)
    await this.ctx.storage.put(`${SUB_PREFIX}${cid}:${subId}`, filters)

    try {
      for (const event of await queryAll(this.store, filters, seconds())) send(['EVENT', subId, event])
      send(['EOSE', subId])
    } catch (error) {
      console.error('query failed', error)
      await this.removeSub(cid, subId)
      send(['CLOSED', subId, 'error: query failed'])
    }
  }

  private async fanOut(event: NostrEvent): Promise<void> {
    const subs = await this.subscriptions()
    for (const ws of this.ctx.getWebSockets()) {
      const own = subs.get((ws.deserializeAttachment() as Attachment).cid)
      if (!own) continue
      for (const [subId, filters] of own) {
        if (filters.some((f) => matchFilter(f, event))) ws.send(JSON.stringify(['EVENT', subId, event]))
      }
    }
  }

  private count(result: { status: Broadcast['status']; rowsWritten: number }): void {
    this.counters.accepted++
    if (result.status !== 'ephemeral') this.counters.stored++
    this.counters.rowsWritten += result.rowsWritten
  }

  private async snapshotCounters(): Promise<Counters> {
    const subs = await this.subscriptions()
    let subscriptions = 0
    for (const own of subs.values()) subscriptions += own.size
    return { ...this.counters, connections: this.ctx.getWebSockets().length, subscriptions }
  }

  /** In-memory copy of the subscriptions, rebuilt from storage after waking from hibernation. */
  private async subscriptions(): Promise<Map<string, Map<string, Filter[]>>> {
    if (this.subs) return this.subs
    const live = new Set(this.ctx.getWebSockets().map((ws) => (ws.deserializeAttachment() as Attachment).cid))
    const stored = await this.ctx.storage.list<Filter[]>({ prefix: SUB_PREFIX })
    const subs = new Map<string, Map<string, Filter[]>>()
    const orphans: string[] = []
    for (const [key, filters] of stored) {
      const [cid, subId] = splitKey(key)
      if (!live.has(cid)) {
        orphans.push(key)
        continue
      }
      const own = subs.get(cid) ?? new Map<string, Filter[]>()
      own.set(subId, filters)
      subs.set(cid, own)
    }
    if (orphans.length > 0) await this.ctx.storage.delete(orphans)
    this.subs = subs
    return subs
  }

  private async removeSub(cid: string, subId: string): Promise<void> {
    ;(await this.subscriptions()).get(cid)?.delete(subId)
    await this.ctx.storage.delete(`${SUB_PREFIX}${cid}:${subId}`)
  }

  private async dropConnection(ws: WebSocket): Promise<void> {
    const { cid } = ws.deserializeAttachment() as Attachment
    const subs = await this.subscriptions()
    const keys = [...(subs.get(cid)?.keys() ?? [])].map((subId) => `${SUB_PREFIX}${cid}:${subId}`)
    subs.delete(cid)
    if (keys.length > 0) await this.ctx.storage.delete(keys)
    try {
      ws.close(1000, 'bye')
    } catch {
      // already closed
    }
  }
}

function splitKey(key: string): [string, string] {
  const rest = key.slice(SUB_PREFIX.length)
  const i = rest.indexOf(':')
  return [rest.slice(0, i), rest.slice(i + 1)]
}
