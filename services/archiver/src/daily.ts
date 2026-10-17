import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import {
  ALLOWED_KINDS,
  ANY_CITY,
  KIND,
  NOSTR_KIND,
  SECONDS_PER_DAY,
  canonicalNdjson,
  isHex64,
  isSystemKind,
  kindClass,
  parseAddress,
  tagValues,
  utcDayRange,
  validateContent,
  validateEvent,
  type SignedEvent,
  type SnapshotContent,
} from '@smartcity/schemas'
import { verifyEvent } from 'nostr-tools/pure'

/** SNAP-1: a day is archived once 48 h have passed since it ended, to catch late events of offline clients. */
export const GRACE_SECONDS = 2 * SECONDS_PER_DAY

/** Without an exclusion policy (SNAP-3) only deletions are applied. */
export const NO_POLICY = 'none'

export interface DailyInput {
  city: string
  /** UTC day `YYYY-MM-DD`. */
  day: string
  /** Events of the day from every known relay, duplicates included (SNAP-5, DATA-6). */
  events: readonly SignedEvent[]
  /** Kind 5 deletion requests known when generating, from any day (SNAP-3). */
  deletions: readonly SignedEvent[]
  /** Relays the events came from, as `wss://` URLs, for the `relays` field. */
  relays: readonly string[]
  /** Seconds. */
  now: number
}

export interface DailySnapshot {
  /** `sc_<city>_<YYYY-MM-DD>.ndjson.gz`. */
  name: string
  ndjson: string
  gzip: Uint8Array
  /** Content of the `snapshot` event (kind 1482). */
  content: SnapshotContent
  /** The `snapshot` event to sign and publish. */
  template: { kind: number; created_at: number; tags: string[][]; content: string }
  /** Lines left out, with the reason: they do not stop the rest. */
  discarded: { id: string; reason: string }[]
  /** Events left out because their author asked to delete them (SNAP-3). */
  deleted: number
}

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')

/**
 * Checks `id` and `sig` on a fresh copy of the seven fields: nostr-tools caches the result of `verifyEvent` on
 * the object, and an event built in this process would otherwise pass without being checked again.
 */
function verifies({ id, pubkey, created_at, kind, tags, content, sig }: SignedEvent): boolean {
  return verifyEvent({ id, pubkey, created_at, kind, tags, content, sig })
}

/** The city an event belongs to (docs/spec/06, "Formato"): its `c` tag, or `d` for a `city`. */
function belongsTo(event: SignedEvent, city: string): boolean {
  const owner = event.kind === KIND.CITY ? tagValues(event.tags, 'd')[0] : tagValues(event.tags, 'c')[0]
  return owner === city || owner === ANY_CITY
}

function expired(event: SignedEvent, now: number): boolean {
  const value = Number(tagValues(event.tags, 'expiration')[0])
  return Number.isSafeInteger(value) && value > 0 && value <= now
}

/** Why an event cannot go into the day's file, or null if it can. */
function rejection(event: SignedEvent, city: string, range: { from: number; to: number }, now: number): string | null {
  if (!verifies(event)) return 'invalid id or signature'
  if (!ALLOWED_KINDS.includes(event.kind)) return `kind ${event.kind} is not accepted`
  const cls = kindClass(event.kind)
  if (cls !== 'regular' && cls !== 'addressable') return `${cls} events are not archived`
  if (!belongsTo(event, city)) return `not from city ${city}`
  if (event.created_at < range.from || event.created_at >= range.to) return 'created_at outside the day'
  if (expired(event, now)) return 'expired (NIP-40)'
  if (isSystemKind(event.kind)) {
    const result = validateEvent(event)
    if (!result.ok) return result.errors.join('; ')
  }
  return null
}

/**
 * Tells whether a valid deletion of its author covers an event (DATA-8, NIP-09, as the relay applies it):
 * `e` tags by id, never another deletion; `a` tags by address, versions up to the deletion's date.
 */
export function deletionIndex(deletions: readonly SignedEvent[]): (event: SignedEvent) => boolean {
  const ids = new Map<string, Set<string>>()
  const addresses = new Map<string, number>()
  for (const deletion of deletions) {
    if (deletion.kind !== NOSTR_KIND.DELETION || !verifies(deletion)) continue
    for (const id of tagValues(deletion.tags, 'e').filter(isHex64)) {
      const authors = ids.get(id) ?? new Set<string>()
      ids.set(id, authors.add(deletion.pubkey))
    }
    for (const value of tagValues(deletion.tags, 'a')) {
      const address = parseAddress(value)
      if (!address || address.pubkey !== deletion.pubkey) continue
      const key = `${address.kind}:${address.pubkey}:${address.d}`
      addresses.set(key, Math.max(addresses.get(key) ?? -Infinity, deletion.created_at))
    }
  }
  return (event) => {
    if (event.kind === NOSTR_KIND.DELETION) return false
    if (ids.get(event.id)?.has(event.pubkey)) return true
    if (kindClass(event.kind) !== 'addressable') return false
    const d = tagValues(event.tags, 'd')[0] ?? ''
    const until = addresses.get(`${event.kind}:${event.pubkey}:${d}`)
    return until !== undefined && event.created_at <= until
  }
}

/**
 * Builds the daily file of a city (docs/spec/06, "Formato") from the events of every relay (SNAP-5): verifies
 * `id` and `sig` of each one, leaves out what does not belong to the day and what its author deleted (SNAP-3),
 * and computes the canonical hash `x`, the `.gz` and the `snapshot` event to sign. Refuses a day still inside
 * the grace period (SNAP-1).
 */
export function buildDaily(input: DailyInput): DailySnapshot {
  const range = utcDayRange(input.day)
  if (!range) throw new Error(`day must be a UTC date YYYY-MM-DD: ${input.day}`)
  if (input.now < range.to + GRACE_SECONDS) {
    throw new Error(`${input.day} is still in the 48 h grace period (SNAP-1)`)
  }

  const isDeleted = deletionIndex(input.deletions)
  const discarded: DailySnapshot['discarded'] = []
  const seen = new Set<string>()
  const kept: SignedEvent[] = []
  let deleted = 0
  for (const event of input.events) {
    if (seen.has(event.id)) continue
    seen.add(event.id)
    const reason = rejection(event, input.city, range, input.now)
    if (reason) discarded.push({ id: event.id, reason })
    else if (isDeleted(event)) deleted++
    else kept.push(event)
  }

  const ndjson = canonicalNdjson(kept)
  const gzip = new Uint8Array(gzipSync(ndjson))
  const name = `sc_${input.city}_${input.day}.ndjson.gz`
  const x = sha256(ndjson)
  const content: SnapshotContent = {
    v: 1,
    from: range.from,
    to: range.to,
    count: kept.length,
    format: 'ndjson+gzip',
    x,
    file: { name, x: sha256(gzip), size: gzip.length },
    relays: [...input.relays],
    policy: NO_POLICY,
  }
  const valid = validateContent(KIND.SNAPSHOT, content)
  if (!valid.ok) throw new Error(`snapshot content does not validate: ${valid.errors.join('; ')}`)
  const template = {
    kind: KIND.SNAPSHOT,
    created_at: input.now,
    tags: [
      ['c', input.city],
      ['t', 'daily'],
      ['x', x],
    ],
    content: JSON.stringify(content),
  }
  return { name, ndjson, gzip, content, template, discarded, deleted }
}
