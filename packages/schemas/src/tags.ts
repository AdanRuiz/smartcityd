import { ANY_CITY, GEOHASH_PRECISIONS, KIND, RELEASE_CHANNELS, ROLES, SNAPSHOT_TYPES, type SystemKind } from './kinds.js'

const HEX64 = /^[0-9a-f]{64}$/
const CITY_ID = /^[a-z]{2}-[a-z0-9-]+$/
const GEOHASH = /^[0-9b-hjkmnp-z]+$/
const ADDRESS = /^(\d+):([0-9a-f]{64}):(.+)$/s

export function isHex64(value: unknown): value is string {
  return typeof value === 'string' && HEX64.test(value)
}

// EVT-1
export function isCityId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 32 && CITY_ID.test(value)
}

export interface Address {
  kind: number
  pubkey: string
  d: string
}

// `<kind>:<pubkey>:<d>` (tag `a`). `d` may itself contain colons.
export function parseAddress(value: string): Address | null {
  const m = ADDRESS.exec(value)
  return m ? { kind: Number(m[1]), pubkey: m[2]!, d: m[3]! } : null
}

export function formatAddress({ kind, pubkey, d }: Address): string {
  return `${kind}:${pubkey}:${d}`
}

export function tagValues(tags: readonly (readonly string[])[], name: string): string[] {
  const out: string[] = []
  for (const tag of tags) if (tag[0] === name && typeof tag[1] === 'string') out.push(tag[1])
  return out
}

type Tags = readonly (readonly string[])[]
type Check = (tags: Tags, errors: string[]) => void

function single(name: string, test: (v: string) => boolean, what: string): Check {
  return (tags, errors) => {
    const values = tagValues(tags, name)
    if (values.length !== 1) errors.push(`expected exactly one "${name}" tag (${what}), found ${values.length}`)
    else if (!test(values[0]!)) errors.push(`"${name}" tag is not ${what}`)
  }
}

function each(name: string, test: (v: string) => boolean, what: string, min = 0): Check {
  return (tags, errors) => {
    const values = tagValues(tags, name)
    if (values.length < min) errors.push(`expected at least ${min} "${name}" tag (${what})`)
    else if (!values.every(test)) errors.push(`every "${name}" tag must be ${what}`)
  }
}

const nonEmpty = (v: string) => v.length > 0
const isCategory = (v: string) => v.length > 0 && v === v.toLowerCase()
const isAddressOf = (kind: number) => (v: string) => parseAddress(v)?.kind === kind

const city = single('c', isCityId, 'a city id')
const d = single('d', nonEmpty, 'a non-empty identifier')
const category = each('t', isCategory, 'lowercase text', 1)

// Exactly one dataset address; any `a` pointing at a source must be well-formed too.
const dataset: Check = (tags, errors) => {
  const a = tagValues(tags, 'a')
  const datasets = a.filter((v) => v.startsWith(`${KIND.DATASET}:`))
  if (datasets.length !== 1 || !isAddressOf(KIND.DATASET)(datasets[0]!)) {
    errors.push(`expected exactly one "a" tag with a dataset address (${KIND.DATASET}:<pubkey>:<d>)`)
  }
  if (!a.filter((v) => v.startsWith(`${KIND.SOURCE}:`)).every(isAddressOf(KIND.SOURCE))) {
    errors.push(`"a" tag is not a valid source address (${KIND.SOURCE}:<pubkey>:<d>)`)
  }
}

// EVT-3: three `g` tags, precision 4, 5 and 6, of the same point.
function geo(required: boolean): Check {
  return (tags, errors) => {
    const g = tagValues(tags, 'g').sort((a, b) => a.length - b.length)
    if (g.length === 0 && !required) return
    const ok =
      g.length === GEOHASH_PRECISIONS.length &&
      g.every((v, i) => v.length === GEOHASH_PRECISIONS[i] && GEOHASH.test(v) && (i === 0 || v.startsWith(g[i - 1]!)))
    if (!ok) errors.push(`expected three "g" tags (geohash precision ${GEOHASH_PRECISIONS.join(', ')}) of the same point`)
  }
}

// The file hash in the `x` tag must be the one the content announces.
function hashMatches(expected: unknown): Check {
  return (tags, errors) => {
    const x = tagValues(tags, 'x')
    if (x.length !== 1 || x[0] !== expected) errors.push('expected exactly one "x" tag equal to the hash in the content')
  }
}

const rolesList: Check = (tags, errors) => {
  const cityId = tagValues(tags, 'd')[0]
  if (!isCityId(cityId)) errors.push('"d" tag is not a city id')
  else if (tagValues(tags, 'c')[0] !== cityId) errors.push('"c" tag must equal the "d" tag')
  for (const tag of tags) {
    if (tag[0] !== 'p') continue
    if (!isHex64(tag[1])) errors.push('"p" tag is not a pubkey')
    else if (!(ROLES as readonly unknown[]).includes(tag[2])) errors.push(`"p" tag has an unknown role: ${String(tag[2])}`)
  }
}

interface Located {
  loc?: unknown
  x?: unknown
  single?: { x?: unknown }
}

/**
 * Checks the mandatory tags of a system kind (docs/spec/03). `content` is the already schema-validated content.
 * Returns the list of problems; empty when the tags are fine.
 */
export function checkTags(kind: SystemKind, tags: Tags, content: object): string[] {
  const c = content as Located
  const hasLoc = c.loc !== undefined
  const checks: Record<SystemKind, Check[]> = {
    [KIND.CITY]: [single('d', isCityId, 'a city id')],
    [KIND.DATASET]: [d, single('c', (v) => v === ANY_CITY || isCityId(v), `a city id or "${ANY_CITY}"`), category],
    [KIND.SOURCE]: [d, city, dataset, geo(hasLoc)],
    [KIND.APP]: [d, each('c', isCityId, 'a city id'), each('a', isAddressOf(KIND.DATASET), 'a dataset address')],
    [KIND.ROLES]: [d, city, rolesList],
    [KIND.STATE]: [d, city, dataset, geo(hasLoc)],
    [KIND.RELEASE]: [
      single('d', (v) => new RegExp(`^[^:]+:(${RELEASE_CHANNELS.join('|')})$`).test(v), '<app slug>:<channel>'),
      hashMatches(c.single?.x),
    ],
    [KIND.OBSERVATION]: [city, dataset, geo(hasLoc)],
    [KIND.REPORT]: [city, category, geo(true)],
    [KIND.SNAPSHOT]: [
      city,
      single('t', (v) => (SNAPSHOT_TYPES as readonly string[]).includes(v), SNAPSHOT_TYPES.join(' | ')),
      hashMatches(c.x),
    ],
    [KIND.REPORT_UPDATE]: [city, single('e', isHex64, 'an event id'), each('p', isHex64, 'a pubkey', 1)],
    [KIND.LIVE]: [d, city, dataset, geo(true)],
  }
  const errors: string[] = []
  for (const check of checks[kind]) check(tags, errors)
  return errors
}

/** What a kind 5 deletion asks to remove (DATA-8, NIP-09), counting only what its own author owns. */
export interface DeletionTargets {
  /** Ids from `e` tags; they cover an event only if it has the deletion's author and is not itself a deletion. */
  ids: string[]
  /** Addresses from `a` tags of the deletion's author; they cover the versions with `created_at <= until`. */
  addresses: (Address & { until: number })[]
}

/**
 * Targets of a deletion, shared by the relay (which deletes them) and the archiver (which leaves them out of a
 * snapshot, SNAP-3) so both agree on what a deletion covers. Does not check the deletion's kind or signature.
 */
export function deletionTargets(deletion: {
  pubkey: string
  created_at: number
  tags: readonly (readonly string[])[]
}): DeletionTargets {
  const ids = tagValues(deletion.tags, 'e').filter(isHex64)
  const addresses: DeletionTargets['addresses'] = []
  for (const value of tagValues(deletion.tags, 'a')) {
    const address = parseAddress(value)
    if (address && address.pubkey === deletion.pubkey) addresses.push({ ...address, until: deletion.created_at })
  }
  return { ids, addresses }
}

/**
 * NIP-40 expiration of an event (first `expiration` tag, a positive safe integer of seconds), or null. One
 * definition for the relay, which deletes the event when it passes, and the archiver, which never archives an
 * event that carries one (SNAP-16).
 */
export function expirationOf(tags: readonly (readonly string[])[]): number | null {
  const value = Number(tagValues(tags, 'expiration')[0])
  return Number.isSafeInteger(value) && value > 0 ? value : null
}
