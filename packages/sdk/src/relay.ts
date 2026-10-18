import type { NostrEvent } from './event.js'
import { OPEN, clearTimer, setTimer, type WebSocketConstructor, type WebSocketLike } from './runtime.js'

export type Filter = {
  ids?: string[]
  authors?: string[]
  kinds?: number[]
  since?: number
  until?: number
  limit?: number
} & { [tag: `#${string}`]: string[] | undefined }

export type RelayState = 'idle' | 'connecting' | 'open' | 'closed'

/** SDK-10: what the UI shows for each relay. */
export interface RelayStatus {
  url: string
  read: boolean
  write: boolean
  state: RelayState
  /** Round trip of the last `OK` or `EOSE`, in milliseconds. */
  latencyMs: number | null
  lastError: string | null
}

export interface SubscriptionHandlers {
  onevent(raw: unknown): void
  oneose?(): void
  onclosed?(reason: string): void
}

export interface RelayOptions {
  WebSocket: WebSocketConstructor
  onChange(): void
  connectTimeoutMs?: number
}

interface Sub {
  filters: Filter[]
  handlers: SubscriptionHandlers
  sentAt: number
}

interface PendingOk {
  resolve(result: { ok: boolean; message: string }): void
  reject(error: Error): void
  timer: unknown
  sentAt: number
}

const MAX_BACKOFF_MS = 60_000
let nextSubId = 0

/** One NIP-01 connection. Reconnects with exponential backoff while it has open subscriptions. */
export class Relay {
  read = true
  write = true
  state: RelayState = 'idle'
  latencyMs: number | null = null
  lastError: string | null = null

  private ws: WebSocketLike | null = null
  private opening: Promise<void> | null = null
  private readonly subs = new Map<string, Sub>()
  private readonly pending = new Map<string, PendingOk>()
  private readonly sending = new Map<string, Promise<{ ok: boolean; message: string }>>()
  private failures = 0
  private reconnectTimer: unknown = null
  private closedByUser = false

  constructor(
    readonly url: string,
    private readonly options: RelayOptions,
  ) {}

  status(): RelayStatus {
    const { url, read, write, state, latencyMs, lastError } = this
    return { url, read, write, state, latencyMs, lastError }
  }

  private update(changes: Partial<Pick<Relay, 'state' | 'latencyMs' | 'lastError'>>): void {
    Object.assign(this, changes)
    this.options.onChange()
  }

  connect(): Promise<void> {
    if (this.ws?.readyState === OPEN) return Promise.resolve()
    this.closedByUser = false
    return (this.opening ??= this.open().finally(() => (this.opening = null)))
  }

  private open(): Promise<void> {
    this.update({ state: 'connecting' })
    return new Promise((resolve, reject) => {
      let ws: WebSocketLike
      try {
        ws = new this.options.WebSocket(this.url)
      } catch (error) {
        this.update({ state: 'closed', lastError: String(error) })
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      const timer = setTimer(() => {
        ws.close()
        fail('connection timeout')
      }, this.options.connectTimeoutMs ?? 7000)
      let settled = false
      const fail = (reason: string) => {
        if (settled) return
        settled = true
        clearTimer(timer)
        this.update({ state: 'closed', lastError: reason })
        reject(new Error(`${this.url}: ${reason}`))
        this.scheduleReconnect()
      }
      ws.onopen = () => {
        settled = true
        clearTimer(timer)
        this.ws = ws
        this.failures = 0
        this.update({ state: 'open' })
        for (const [id, sub] of this.subs) this.sendReq(id, sub)
        resolve()
      }
      ws.onerror = () => fail('connection error')
      ws.onclose = () => {
        if (!settled) return fail('connection closed')
        if (this.ws !== ws) return
        this.ws = null
        this.update({ state: 'closed' })
        for (const [id, p] of this.pending) {
          clearTimer(p.timer)
          p.reject(new Error(`${this.url}: connection closed`))
          this.pending.delete(id)
        }
        this.scheduleReconnect()
      }
      ws.onmessage = (m) => this.receive(m.data)
    })
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.subs.size === 0 || this.reconnectTimer !== null) return
    const delay = Math.min(1000 * 2 ** this.failures++, MAX_BACKOFF_MS) * (0.75 + Math.random() / 2)
    this.reconnectTimer = setTimer(() => {
      this.reconnectTimer = null
      if (this.subs.size > 0) this.connect().catch(() => {})
    }, delay)
  }

  private receive(data: unknown): void {
    let msg: unknown
    try {
      msg = JSON.parse(String(data))
    } catch {
      return
    }
    if (!Array.isArray(msg)) return
    const [type, a, b, c] = msg as unknown[]
    if (type === 'EVENT' && typeof a === 'string') this.subs.get(a)?.handlers.onevent(b)
    else if (type === 'EOSE' && typeof a === 'string') {
      const sub = this.subs.get(a)
      if (!sub) return
      this.update({ latencyMs: Date.now() - sub.sentAt })
      sub.handlers.oneose?.()
    } else if (type === 'CLOSED' && typeof a === 'string') {
      const sub = this.subs.get(a)
      this.subs.delete(a)
      sub?.handlers.onclosed?.(String(b ?? ''))
    } else if (type === 'OK' && typeof a === 'string') {
      const p = this.pending.get(a)
      if (!p) return
      this.pending.delete(a)
      clearTimer(p.timer)
      this.update({ latencyMs: Date.now() - p.sentAt })
      p.resolve({ ok: b === true, message: String(c ?? '') })
    } else if (type === 'NOTICE') this.update({ lastError: String(a) })
  }

  /**
   * Sends an event and resolves with the relay's `OK`. Rejects when it cannot be delivered. The `OK` names only the
   * event id, so a second publish of an event still in flight (a background retry and the outbox) shares the first.
   */
  publish(event: NostrEvent, timeoutMs = 10_000): Promise<{ ok: boolean; message: string }> {
    let sending = this.sending.get(event.id)
    if (!sending) {
      sending = this.send(event, timeoutMs).finally(() => this.sending.delete(event.id))
      this.sending.set(event.id, sending)
    }
    return sending
  }

  private async send(event: NostrEvent, timeoutMs: number): Promise<{ ok: boolean; message: string }> {
    await this.connect()
    return new Promise((resolve, reject) => {
      const timer = setTimer(() => {
        this.pending.delete(event.id)
        this.update({ lastError: 'timeout waiting for OK' })
        reject(new Error(`${this.url}: timeout waiting for OK`))
      }, timeoutMs)
      this.pending.set(event.id, { resolve, reject, timer, sentAt: Date.now() })
      this.ws!.send(JSON.stringify(['EVENT', event]))
    })
  }

  subscribe(filters: Filter[], handlers: SubscriptionHandlers): { close(): void } {
    const id = `sc${(nextSubId++).toString(36)}`
    const sub: Sub = { filters, handlers, sentAt: Date.now() }
    this.subs.set(id, sub)
    if (this.ws?.readyState === OPEN) this.sendReq(id, sub)
    else
      this.connect().catch((error: Error) => {
        // The subscription stays registered and is sent again on reconnection.
        handlers.onclosed?.(`error: ${error.message}`)
      })
    return {
      close: () => {
        if (!this.subs.delete(id)) return
        if (this.ws?.readyState === OPEN) this.ws.send(JSON.stringify(['CLOSE', id]))
      },
    }
  }

  private sendReq(id: string, sub: Sub): void {
    sub.sentAt = Date.now()
    this.ws!.send(JSON.stringify(['REQ', id, ...sub.filters]))
  }

  close(): void {
    this.closedByUser = true
    if (this.reconnectTimer !== null) clearTimer(this.reconnectTimer)
    this.reconnectTimer = null
    this.subs.clear()
    const ws = this.ws
    this.ws = null
    ws?.close()
    this.update({ state: 'closed' })
  }
}
