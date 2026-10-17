import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import {
  ALLOWED_KINDS,
  ANY_CITY,
  KIND,
  NOSTR_KIND,
  SECONDS_PER_DAY,
  canonicalNdjson,
  deletionTargets,
  expirationOf,
  isHex64,
  isSystemKind,
  kindClass,
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
  /** Events of the day from every known relay, duplicates included (SNAP-5, DATA-6). Unchecked relay data. */
  events: readonly unknown[]
  /** Kind 5 deletion requests known when generating, from any day (SNAP-3). Unchecked relay data. */
  deletions: readonly unknown[]
  /** Relays the events came from, as `wss://` URLs, for the `relays` field. */
  relays: readonly string[]
  /** Seconds. */
  now: number
}

export interface AddendumInput extends DailyInput {
  /** Ids already in the day's published files, the daily and earlier addenda: they are not repeated (SNAP-2). */
  archived: ReadonlySet<string>
  /** `N` of `_a<N>`, from 1. */
  n: number
}

export interface DailySnapshot {
  /** `sc_<city>_<YYYY-MM-DD>.ndjson.gz`, or `sc_<city>_<YYYY-MM-DD>_a<N>.ndjson.gz` for an addendum. */
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
  /** Valid events left out because a published file of the day already has them (SNAP-2). */
  archived: number
}

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')

/** Whether relay data has the shape of a NIP-01 event, so it can be verified without throwing. */
export function isEventShape(value: unknown): value is SignedEvent {
  if (typeof value !== 'object' || value === null) return false
  const e = value as Record<string, unknown>
  return (
    isHex64(e.id) &&
    isHex64(e.pubkey) &&
    typeof e.sig === 'string' &&
    typeof e.content === 'string' &&
    Number.isSafeInteger(e.kind) &&
    Number.isSafeInteger(e.created_at) &&
    Array.isArray(e.tags) &&
    e.tags.every((tag) => Array.isArray(tag) && tag.every((part) => typeof part === 'string'))
  )
}

/**
 * Checks `id` and `sig` on a fresh copy of the seven fields: nostr-tools caches the result of `verifyEvent` on
 * the object, and an event built in this process would otherwise pass without being checked again. Never throws:
 * a line a relay got wrong is discarded, not fatal (SNAP-6).
 */
function verifies(value: unknown): value is SignedEvent {
  if (!isEventShape(value)) return false
  const { id, pubkey, created_at, kind, tags, content, sig } = value
  try {
    return verifyEvent({ id, pubkey, created_at, kind, tags, content, sig })
  } catch {
    return false
  }
}

/** The city an event belongs to (docs/spec/06, "Formato"): its `c` tag, or `d` for a `city`. */
function belongsTo(event: SignedEvent, city: string): boolean {
  const owner = event.kind === KIND.CITY ? tagValues(event.tags, 'd')[0] : tagValues(event.tags, 'c')[0]
  return owner === city || owner === ANY_CITY
}

/** Why an event cannot go into the day's file, or null if it can. */
function rejection(event: unknown, city: string, range: { from: number; to: number }): string | null {
  if (!isEventShape(event)) return 'not a NIP-01 event'
  if (!verifies(event)) return 'invalid id or signature'
  if (!ALLOWED_KINDS.includes(event.kind)) return `kind ${event.kind} is not accepted`
  const cls = kindClass(event.kind)
  if (cls !== 'regular' && cls !== 'addressable') return `${cls} events are not archived`
  if (!belongsTo(event, city)) return `not from city ${city}`
  if (event.created_at < range.from || event.created_at >= range.to) return 'created_at outside the day'
  // SNAP-16 (ADR-21): an author who sets a NIP-40 expiration marks the event as temporary, and a snapshot is
  // permanent, so it is left out whatever the date. Also keeps the file independent of when it is generated.
  if (expirationOf(event) !== null) return 'has NIP-40 expiration (SNAP-16)'
  if (isSystemKind(event.kind)) {
    const result = validateEvent(event)
    if (!result.ok) return result.errors.join('; ')
  }
  return null
}

/**
 * Tells whether a valid deletion of its author covers an event (DATA-8, NIP-09), with the same targets the relay
 * deletes (`deletionTargets`): `e` tags by id, never another deletion; `a` tags by address, versions up to the
 * deletion's date.
 */
export function deletionIndex(deletions: readonly unknown[]): (event: SignedEvent) => boolean {
  const ids = new Map<string, Set<string>>()
  const addresses = new Map<string, number>()
  for (const deletion of deletions) {
    if (!verifies(deletion) || deletion.kind !== NOSTR_KIND.DELETION) continue
    const targets = deletionTargets(deletion)
    for (const id of targets.ids) {
      const authors = ids.get(id) ?? new Set<string>()
      ids.set(id, authors.add(deletion.pubkey))
    }
    for (const { kind, pubkey, d, until } of targets.addresses) {
      const key = `${kind}:${pubkey}:${d}`
      addresses.set(key, Math.max(addresses.get(key) ?? -Infinity, until))
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
  return build(input, 'daily', `sc_${input.city}_${input.day}.ndjson.gz`, new Set())
}

/**
 * Builds addendum `N` of a day already published (SNAP-2): the same checks as `buildDaily`, keeping only the
 * events none of the day's files has. Its `from` and `to` are the day's, so its `count` adds up with the
 * daily's (RELAY-4). With nothing new, `count` is 0 and there is nothing to publish.
 */
export function buildAddendum(input: AddendumInput): DailySnapshot {
  if (!Number.isSafeInteger(input.n) || input.n < 1) throw new Error(`addendum number must be 1 or more: ${input.n}`)
  return build(input, 'addendum', `sc_${input.city}_${input.day}_a${input.n}.ndjson.gz`, input.archived)
}

function build(input: DailyInput, type: 'daily' | 'addendum', name: string, archived: ReadonlySet<string>): DailySnapshot {
  const range = utcDayRange(input.day)
  if (!range) throw new Error(`day must be a UTC date YYYY-MM-DD: ${input.day}`)
  if (input.now < range.to + GRACE_SECONDS) {
    throw new Error(`${input.day} is still in the 48 h grace period (SNAP-1)`)
  }

  const isDeleted = deletionIndex(input.deletions)
  const discarded: DailySnapshot['discarded'] = []
  const reported = new Set<string>()
  // Only copies that passed verification count as seen: a forged copy from one relay must not hide the good
  // copy of the same id from another (SNAP-5).
  const seen = new Set<string>()
  const kept: SignedEvent[] = []
  let deleted = 0
  let already = 0
  for (const event of input.events) {
    const id = isEventShape(event) ? event.id : String((event as { id?: unknown } | null)?.id ?? '?')
    if (seen.has(id)) continue
    const reason = rejection(event, input.city, range)
    if (reason) {
      if (!reported.has(id)) discarded.push({ id, reason })
      reported.add(id)
      continue
    }
    const valid = event as SignedEvent
    seen.add(id)
    if (archived.has(id)) already++
    else if (isDeleted(valid)) deleted++
    else kept.push(valid)
  }
  // An id first seen as a bad copy and later as a good one is not reported as discarded.
  const discardedOut = discarded.filter((d) => !seen.has(d.id))

  const ndjson = canonicalNdjson(kept)
  const gzip = new Uint8Array(gzipSync(ndjson))
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
      ['t', type],
      ['x', x],
    ],
    content: JSON.stringify(content),
  }
  return { name, ndjson, gzip, content, template, discarded: discardedOut, deleted, archived: already }
}
