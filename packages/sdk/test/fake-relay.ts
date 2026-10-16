import { KIND, tagValues } from '@smartcity/schemas'
import { verifyEvent } from 'nostr-tools/pure'
import type { Filter, NostrEvent, WebSocketConstructor, WebSocketLike } from '../src/index.js'

/** In-memory NIP-01 relay, enough to exercise the SDK. */
export class FakeRelay {
  events: NostrEvent[] = []
  down = false
  /** Answer for an incoming event; null accepts it. */
  reject: (event: NostrEvent) => string | null = () => null
  /** Swallow EVENT messages without answering. */
  silent = false
  received: unknown[][] = []
  readonly sockets = new Set<FakeSocket>()

  constructor(readonly url: string) {}

  /** Stores an event as if it had been published, without checks (to plant bad data). */
  plant(event: NostrEvent): void {
    this.events.push(event)
  }

  handle(socket: FakeSocket, msg: unknown[]): void {
    this.received.push(msg)
    const [type, a, ...rest] = msg
    if (type === 'EVENT') {
      if (this.silent) return
      const event = a as NostrEvent
      const reason = verifyEvent(event) ? this.reject(event) : 'invalid: bad signature'
      if (reason) return socket.deliver(['OK', event.id, false, reason])
      if (this.events.some((e) => e.id === event.id)) return socket.deliver(['OK', event.id, true, 'duplicate: already have it'])
      this.events.push(event)
      socket.deliver(['OK', event.id, true, ''])
      for (const s of this.sockets) {
        for (const [id, filters] of s.subs) if (filters.some((f) => matches(f, event))) s.deliver(['EVENT', id, event])
      }
    } else if (type === 'REQ') {
      const filters = rest as Filter[]
      socket.subs.set(a as string, filters)
      for (const event of this.events) if (filters.some((f) => matches(f, event))) socket.deliver(['EVENT', a, event])
      socket.deliver(['EOSE', a])
    } else if (type === 'CLOSE') socket.subs.delete(a as string)
  }

  /** Drops every connection, as a restart would. */
  disconnectAll(): void {
    for (const s of [...this.sockets]) s.close()
  }
}

function matches(f: Filter, e: NostrEvent): boolean {
  if (f.ids && !f.ids.includes(e.id)) return false
  if (f.authors && !f.authors.includes(e.pubkey)) return false
  if (f.kinds && !f.kinds.includes(e.kind)) return false
  if (f.since !== undefined && e.created_at < f.since) return false
  if (f.until !== undefined && e.created_at > f.until) return false
  for (const [key, wanted] of Object.entries(f)) {
    if (!key.startsWith('#') || !wanted) continue
    const name = key.slice(1)
    const values = tagValues(e.tags, name === 'c' && e.kind === KIND.CITY ? 'd' : name)
    if (!values.some((v) => (wanted as string[]).includes(v))) return false
  }
  return true
}

export class FakeSocket implements WebSocketLike {
  readyState = 0
  onopen: ((ev: unknown) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  readonly subs = new Map<string, Filter[]>()

  constructor(private readonly relay: FakeRelay | undefined) {
    setTimeout(() => {
      if (!relay || relay.down) {
        this.readyState = 3
        this.onerror?.({})
        this.onclose?.({})
        return
      }
      relay.sockets.add(this)
      this.readyState = 1
      this.onopen?.({})
    }, 1)
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('socket not open')
    const relay = this.relay!
    setTimeout(() => relay.handle(this, JSON.parse(data) as unknown[]), 1)
  }

  deliver(msg: unknown[]): void {
    if (this.readyState !== 1) return
    setTimeout(() => this.onmessage?.({ data: JSON.stringify(msg) }), 1)
  }

  close(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.relay?.sockets.delete(this)
    setTimeout(() => this.onclose?.({}), 1)
  }
}

/** A set of fake relays and the WebSocket class that reaches them. */
export function fakeNetwork(...urls: string[]) {
  const relays = new Map(urls.map((u) => [u, new FakeRelay(u)]))
  const WebSocket: WebSocketConstructor = class extends FakeSocket {
    constructor(url: string) {
      super(relays.get(url))
    }
  }
  return { relays, WebSocket, relay: (url: string) => relays.get(url)! }
}
