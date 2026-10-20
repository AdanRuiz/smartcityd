import { ALLOWED_KINDS, ANY_CITY, KIND, MAX_FUTURE_SECONDS, isSystemKind, kindClass, validateEvent } from '@smartcity/schemas'
import { getPow } from 'nostr-tools/nip13'
import { getEventHash, verifyEvent } from 'nostr-tools/pure'
import { IP_RATE_FACTOR, type Config } from './config.js'
import { checkStructure, eventCity, type NostrEvent } from './event.js'
import type { RateLimiter } from './ratelimit.js'
import { roleBookFor, type RoleBook } from './roles.js'
import { StorageFullError, type SaveResult, type SaveStatus, type Store } from './store.js'

export interface AcceptDeps {
  store: Store
  config: Config
  limiter: RateLimiter
  /** Seconds. */
  now: () => number
  /** Roles from the anchors. Default: the shared book for `config.trustAnchors`. */
  roles?: RoleBook
  /**
   * Where the event comes from. Default `client`. Events imported from a snapshot skip the age limit (RELAY-5)
   * and the rate limit, which are for clients; every other step applies.
   */
  origin?: 'client' | 'snapshot'
}

export type AcceptResult =
  | { ok: true; event: NostrEvent; message: string; status: SaveStatus; rowsWritten: number }
  | { ok: false; id: string; message: string }

const DAY = 86_400

// The first verification in an isolate builds the precomputed tables of @noble/curves (~20 ms). Doing it at
// module scope moves that cost to the isolate's startup, which has its own limit, out of the CPU time of the
// first request (measured on Workers: p99 ~30 ms without it, against ~10 ms of the free plan).
const WARM_UP = {
  kind: 1,
  tags: [],
  content: 'warm-up',
  created_at: 1760000000,
  pubkey: '63a31d4a5eb07f59384f714a987ad50d836589a5781010f404845064aa9ebd05',
  id: '144e9ed79901222db17d5c06d7a0ef763bdebce75f4746e7ce445a229e9fbe96',
  sig: '51ac2af81107a582cf37c4c907acb9e18cb726cc4b8b7e647674d34dd04e61f8cc9ccd3e9c36f513335216d307b4c402226e49005dcd5a6105d5e44bd3d14911',
}
if (!verifyEvent(WARM_UP)) throw new Error('warm-up event does not verify')

function idOf(raw: unknown): string {
  const id = (raw as { id?: unknown } | null)?.id
  return typeof id === 'string' ? id : ''
}

/**
 * Acceptance of an event from a client or a snapshot (docs/spec/07, steps 1–9), then storage.
 */
export async function acceptEvent(raw: unknown, ip: string, deps: AcceptDeps): Promise<AcceptResult> {
  const { config, store, limiter } = deps
  const reject = (message: string): AcceptResult => ({ ok: false, id: idOf(raw), message })

  // 1. Size and NIP-01 structure.
  const event = checkStructure(raw)
  if (typeof event === 'string') return reject(`invalid: ${event}`)

  // 2. Allowed kind.
  if (!ALLOWED_KINDS.includes(event.kind)) return reject(`blocked: kind ${event.kind} is not accepted by this relay`)

  // 3. Date (DATA-4; RELAY-5 for regular events from clients).
  const now = deps.now()
  if (event.created_at > now + MAX_FUTURE_SECONDS) return reject('invalid: created_at is too far in the future')
  const fromClient = (deps.origin ?? 'client') === 'client'
  const regular = kindClass(event.kind) === 'regular'
  if (fromClient && regular && config.maxEventAgeDays > 0 && event.created_at < now - config.maxEventAgeDays * DAY) {
    return reject('invalid: too old')
  }

  // 4. Rate limit, before the signature so abuse does not cost CPU (RELAY-3).
  const max = config.rateEventsPerMin
  if (fromClient && !limiter.hit([{ key: `pk:${event.pubkey}`, max }, { key: `ip:${ip}`, max: max * IP_RATE_FACTOR }])) {
    return reject('rate-limited: slow down')
  }

  // 5. id and signature, before any write (RELAY-1, DATA-1, ADR-14).
  if (!verifyEvent(event)) {
    return reject(getEventHash(event) === event.id ? 'invalid: bad signature' : 'invalid: id does not match the event')
  }

  // 6. Already stored.
  if (await store.exists(event.id)) {
    return { ok: true, event, message: 'duplicate: already have this event', status: 'duplicate', rowsWritten: 0 }
  }

  // 7. Content schema and mandatory tags (EVT-7, DATA-5). NIP kinds reused as they are have no schema here.
  if (isSystemKind(event.kind)) {
    const result = validateEvent(event)
    if (!result.ok) return reject(`invalid: ${result.errors.join('; ')}`)
  }

  const city = eventCity(event)
  const specific = city !== null && city !== ANY_CITY ? city : null
  const roles = deps.roles ?? roleBookFor(config.trustAnchors)
  let attested: boolean | undefined
  const isAttested = async () => (attested ??= await roles.isAttested(event.pubkey, specific, store, now))

  // 8. Proof of work (NIP-13, SPAM-1): `report` from keys without a role from the anchors.
  if (event.kind === KIND.REPORT && config.powBitsReport > 0 && getPow(event.id) < config.powBitsReport) {
    if (!(await isAttested())) return reject(`pow: difficulty ${config.powBitsReport} required`)
  }

  // 9. Operator policy: served cities, then who writes. Events for every city (`c` = `*`) and without a city pass
  // the city check.
  if (config.cities && specific !== null && !config.cities.includes(specific)) {
    return reject(`restricted: city ${specific} is not served by this relay`)
  }
  if (config.writePolicy === 'roles' && !(await isAttested())) {
    return reject('restricted: this relay only accepts keys with a role')
  }

  // RELAY-4, ADR-20: when the database is full, new writes are refused; nothing unarchived is deleted for room.
  let saved: SaveResult
  try {
    saved = await store.save(event, now)
  } catch (error) {
    if (error instanceof StorageFullError) return reject('restricted: storage full')
    throw error
  }
  if (saved.status === 'stored' || saved.status === 'replaced') roles.saw(event)
  const duplicate = saved.status === 'stale' || saved.status === 'duplicate'
  const message =
    saved.status === 'stale' ? 'duplicate: a newer version is stored' : duplicate ? 'duplicate: already have this event' : ''
  return { ok: true, event, message, status: saved.status, rowsWritten: saved.rowsWritten }
}

/** True when the result is a new event that subscribers must receive. */
export function isNew(result: AcceptResult): result is Extract<AcceptResult, { ok: true }> {
  return result.ok && (result.status === 'stored' || result.status === 'replaced' || result.status === 'ephemeral')
}
