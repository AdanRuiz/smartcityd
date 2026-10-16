import type { NostrEvent } from './event.js'
import { Relay, type Filter, type RelayStatus } from './relay.js'
import { parseUrl, setTimer, type WebSocketConstructor } from './runtime.js'

export interface PublishResult {
  id: string
  /** Relays that answered `OK true` (or `duplicate:`) by the time the promise resolved. */
  accepted: string[]
  /** Relays that rejected it for good, with the relay's message (`invalid: …`, `blocked: …`). */
  rejected: { relay: string; reason: string }[]
  /** SDK-4 (fase 3): stored in the outbox to resend later. Always false until the outbox exists. */
  queued: boolean
}

export interface RelayFlags {
  read?: boolean
  write?: boolean
}

// Prefixes of a rejection that will not change by retrying (docs/spec/05, §2). `pow:` stays here until SDK-8.
const PERMANENT = ['invalid:', 'blocked:', 'restricted:', 'pow:']
const MAX_ATTEMPTS = 6

function isPermanent(message: string): boolean {
  return PERMANENT.some((p) => message.startsWith(p))
}

/** The set of relays a client talks to. Writes go to every write relay; reads merge every read relay. */
export class Pool {
  private readonly relays = new Map<string, Relay>()
  private readonly listeners = new Set<(status: RelayStatus[]) => void>()

  constructor(
    private readonly WebSocket: WebSocketConstructor,
    private readonly retryBaseMs = 1000,
  ) {}

  add(url: string, flags: RelayFlags = {}): void {
    const key = normalizeUrl(url)
    let relay = this.relays.get(key)
    if (!relay) {
      relay = new Relay(key, { WebSocket: this.WebSocket, onChange: () => this.notify() })
      this.relays.set(key, relay)
    }
    relay.read = flags.read ?? relay.read
    relay.write = flags.write ?? relay.write
    this.notify()
  }

  remove(url: string): void {
    const key = normalizeUrl(url)
    this.relays.get(key)?.close()
    this.relays.delete(key)
    this.notify()
  }

  has(url: string): boolean {
    return this.relays.has(normalizeUrl(url))
  }

  /** SDK-10 */
  status(): RelayStatus[] {
    return [...this.relays.values()].map((r) => r.status())
  }

  onStatus(listener: (status: RelayStatus[]) => void): () => void {
    this.listeners.add(listener)
    listener(this.status())
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    const status = this.status()
    for (const listener of this.listeners) listener(status)
  }

  private readers(): Relay[] {
    return [...this.relays.values()].filter((r) => r.read)
  }

  private writers(): Relay[] {
    return [...this.relays.values()].filter((r) => r.write)
  }

  /**
   * SDK-3, REPL-1: sends to every write relay in parallel. Resolves at the first `OK`, or once every relay has
   * answered at least once without accepting. Relays that failed for a transient reason (connection, timeout,
   * `rate-limited:`) keep retrying in the background with exponential backoff.
   */
  publish(event: NostrEvent): Promise<PublishResult> {
    const result: PublishResult = { id: event.id, accepted: [], rejected: [], queued: false }
    const writers = this.writers()
    if (writers.length === 0) return Promise.resolve(result)
    return new Promise((resolve) => {
      let firstAnswers = 0
      let done = false
      const finish = () => {
        if (done) return
        done = true
        resolve({ ...result, accepted: [...result.accepted], rejected: [...result.rejected] })
      }
      const answered = (attempt: number) => {
        if (attempt === 0 && ++firstAnswers === writers.length) finish()
      }
      const attempt = (relay: Relay, n: number) => {
        relay.publish(event).then(
          ({ ok, message }) => {
            if (ok || message.startsWith('duplicate:')) {
              result.accepted.push(relay.url)
              finish()
            } else if (isPermanent(message) || n + 1 >= MAX_ATTEMPTS) {
              result.rejected.push({ relay: relay.url, reason: message })
            } else retry(relay, n)
            answered(n)
          },
          (error: Error) => {
            if (n + 1 >= MAX_ATTEMPTS) result.rejected.push({ relay: relay.url, reason: `error: ${error.message}` })
            else retry(relay, n)
            answered(n)
          },
        )
      }
      const retry = (relay: Relay, n: number) => {
        if (!this.relays.has(relay.url)) return
        setTimer(() => attempt(relay, n + 1), this.retryBaseMs * 2 ** n)
      }
      for (const relay of writers) attempt(relay, 0)
    })
  }

  /**
   * REPL-2: asks every read relay for what it has stored and calls `onEvent` for each raw message, with no
   * checks: the client verifies. Resolves when every relay has sent `EOSE`, failed, or `timeoutMs` passed.
   */
  query(filters: Filter[], onEvent: (raw: unknown) => void, timeoutMs = 5000): Promise<void> {
    const readers = this.readers()
    return new Promise((resolve) => {
      let left = readers.length
      if (left === 0) return resolve()
      for (const relay of readers) {
        let finished = false
        const done = () => {
          if (finished) return
          finished = true
          sub.close()
          if (--left === 0) resolve()
        }
        const sub = relay.subscribe(filters, { onevent: onEvent, oneose: done, onclosed: done })
        setTimer(done, timeoutMs)
      }
    })
  }

  /** Long-lived subscription on every read relay. Returns the function that closes it. */
  subscribe(filters: Filter[], onEvent: (raw: unknown) => void, onEose?: () => void): () => void {
    const readers = this.readers()
    let eoses = 0
    const subs = readers.map((relay) =>
      relay.subscribe(filters, {
        onevent: onEvent,
        oneose: () => {
          if (++eoses === readers.length) onEose?.()
        },
      }),
    )
    return () => subs.forEach((s) => s.close())
  }

  close(): void {
    for (const relay of this.relays.values()) relay.close()
  }
}

/** `wss://Host/path/` and `wss://host/path` are the same relay. */
export function normalizeUrl(url: string): string {
  const u = parseUrl(url.trim())
  if (u.protocol !== 'wss:' && u.protocol !== 'ws:') throw new Error(`not a relay URL: ${url}`)
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}${u.search}`
}
