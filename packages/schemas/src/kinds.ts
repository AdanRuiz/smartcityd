// Kind numbers assigned for v1 (docs/spec/03, ADR-12). Import them from here; never write them as literals.
export const KIND = {
  CITY: 31480,
  DATASET: 31481,
  SOURCE: 31482,
  APP: 31483,
  ROLES: 31484,
  STATE: 31485,
  RELEASE: 31486,
  OBSERVATION: 1480,
  REPORT: 1481,
  SNAPSHOT: 1482,
  REPORT_UPDATE: 1483,
  LIVE: 21480,
} as const

export type SystemKind = (typeof KIND)[keyof typeof KIND]

// Nostr kinds reused as they are.
export const NOSTR_KIND = {
  DELETION: 5, // NIP-09
  OPENTIMESTAMPS: 1040, // NIP-03
  ABUSE_REPORT: 1984, // NIP-56
  LABEL: 1985, // NIP-32
  RELAY_LIST: 10002, // NIP-65
} as const

// NIP-98 HTTP Auth: the signed authorization of `PUT /v1/blob` (docs/spec/07). Sent in a header, never published,
// so it is not among the kinds a relay accepts.
export const HTTP_AUTH_KIND = 27235

export const SYSTEM_KINDS: readonly number[] = Object.values(KIND)

// Kinds a reference relay accepts (docs/spec/07, acceptance step 2).
export const ALLOWED_KINDS: readonly number[] = [...SYSTEM_KINDS, ...Object.values(NOSTR_KIND)]

export function isSystemKind(kind: number): kind is SystemKind {
  return SYSTEM_KINDS.includes(kind)
}

export type KindClass = 'regular' | 'replaceable' | 'ephemeral' | 'addressable'

// NIP-01 kind ranges.
export function kindClass(kind: number): KindClass {
  if (kind >= 30000 && kind < 40000) return 'addressable'
  if (kind >= 20000 && kind < 30000) return 'ephemeral'
  if ((kind >= 10000 && kind < 20000) || kind === 0 || kind === 3) return 'replaceable'
  return 'regular'
}

export const ROLES = ['authority', 'operator', 'app', 'source', 'archiver', 'moderator', 'blocked'] as const
export type Role = (typeof ROLES)[number]

export const SNAPSHOT_TYPES = ['daily', 'addendum', 'monthly', 'attachments'] as const
export type SnapshotType = (typeof SNAPSHOT_TYPES)[number]

export const RELEASE_CHANNELS = ['stable', 'beta'] as const
export type ReleaseChannel = (typeof RELEASE_CHANNELS)[number]

// Initial report categories; apps may use others.
export const REPORT_CATEGORIES = ['bache', 'alumbrado', 'fuga', 'basura', 'semaforo', 'arbolado', 'otro'] as const

export const MAX_EVENT_BYTES = 64 * 1024 // NFR-5
export const MAX_FUTURE_SECONDS = 15 * 60 // DATA-4
export const GEOHASH_PRECISIONS = [4, 5, 6] as const // EVT-3, ADR-17
export const ANY_CITY = '*'
