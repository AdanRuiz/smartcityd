import { KIND, MAX_EVENT_BYTES, isHex64, kindClass, tagValues } from '@smartcity/schemas'

export interface NostrEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

const SIG = /^[0-9a-f]{128}$/
const encoder = new TextEncoder()

export function byteLength(text: string): number {
  return encoder.encode(text).length
}

/** Acceptance step 1 (docs/spec/07): NIP-01 structure and size. Returns the event or the reason it is invalid. */
export function checkStructure(raw: unknown): NostrEvent | string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'event must be an object'
  const e = raw as Record<string, unknown>
  if (!isHex64(e.id)) return 'id must be 64 lowercase hex characters'
  if (!isHex64(e.pubkey)) return 'pubkey must be 64 lowercase hex characters'
  if (typeof e.sig !== 'string' || !SIG.test(e.sig)) return 'sig must be 128 lowercase hex characters'
  if (!Number.isSafeInteger(e.created_at) || (e.created_at as number) < 0) return 'created_at must be a non-negative integer'
  if (!Number.isInteger(e.kind) || (e.kind as number) < 0 || (e.kind as number) > 65535) return 'kind must be an integer 0-65535'
  if (typeof e.content !== 'string') return 'content must be a string'
  if (!Array.isArray(e.tags) || !e.tags.every((t) => Array.isArray(t) && t.length > 0 && t.every((v) => typeof v === 'string'))) {
    return 'tags must be an array of non-empty string arrays'
  }
  const event: NostrEvent = {
    id: e.id,
    pubkey: e.pubkey,
    created_at: e.created_at as number,
    kind: e.kind as number,
    tags: e.tags as string[][],
    content: e.content,
    sig: e.sig,
  }
  if (byteLength(JSON.stringify(event)) > MAX_EVENT_BYTES) return `event larger than ${MAX_EVENT_BYTES} bytes`
  return event
}

/**
 * Value of the `d` column: the `d` tag of an addressable event (empty when missing, as in NIP-01),
 * `''` for a replaceable one, and null for the rest.
 */
export function addressD(event: NostrEvent): string | null {
  const cls = kindClass(event.kind)
  if (cls === 'addressable') return tagValues(event.tags, 'd')[0] ?? ''
  return cls === 'replaceable' ? '' : null
}

/** Value of the `city` column: tag `c`, or `d` for a city definition (docs/spec/07). */
export function eventCity(event: NostrEvent): string | null {
  if (event.kind === KIND.CITY) return tagValues(event.tags, 'd')[0] ?? null
  return tagValues(event.tags, 'c')[0] ?? null
}

/** DATA-3: the newest wins; on a tie, the lexicographically smaller id. */
export function wins(candidate: { created_at: number; id: string }, current: { created_at: number; id: string }): boolean {
  if (candidate.created_at !== current.created_at) return candidate.created_at > current.created_at
  return candidate.id < current.id
}
