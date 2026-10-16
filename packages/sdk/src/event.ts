import { MAX_EVENT_BYTES, isHex64 } from '@smartcity/schemas'
import { byteLength } from './runtime.js'

export interface NostrEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

/** What a signer receives: an event without `pubkey`, `id` and `sig`. */
export interface EventTemplate {
  kind: number
  created_at: number
  tags: string[][]
  content: string
}

/** What `sc.publish` takes: `created_at` defaults to now and `content` may be an object. */
export interface UnsignedEvent {
  kind: number
  tags: string[][]
  content: string | object
  created_at?: number
}

const SIG = /^[0-9a-f]{128}$/

/** NIP-01 shape and NFR-5 size of something received from a relay. Signature and schema are checked apart. */
export function isWellFormed(raw: unknown): raw is NostrEvent {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false
  const e = raw as Record<string, unknown>
  return (
    isHex64(e.id) &&
    isHex64(e.pubkey) &&
    typeof e.sig === 'string' &&
    SIG.test(e.sig) &&
    Number.isSafeInteger(e.created_at) &&
    Number.isInteger(e.kind) &&
    typeof e.content === 'string' &&
    Array.isArray(e.tags) &&
    e.tags.every((t) => Array.isArray(t) && t.every((v) => typeof v === 'string')) &&
    byteLength(JSON.stringify(raw)) <= MAX_EVENT_BYTES
  )
}

/** DATA-3: the newest wins; on a tie, the lexicographically smaller id. */
export function wins(candidate: NostrEvent, current: NostrEvent): boolean {
  if (candidate.created_at !== current.created_at) return candidate.created_at > current.created_at
  return candidate.id < current.id
}
