import { ANY_CITY, isHex64 } from '@smartcity/schemas'

/** Variables of wrangler.toml (docs/spec/07, "Configuración"). All optional strings, as Workers passes them. */
export interface RelayVars {
  RELAY_NAME?: string
  RELAY_CONTACT?: string
  CITIES?: string
  WRITE_POLICY?: string
  RATE_EVENTS_PER_MIN?: string
  RETENTION_DAYS?: string
  MAX_EVENT_AGE_DAYS?: string
  TRUST_ANCHORS?: string
  POW_BITS_REPORT?: string
}

export interface Config {
  name: string
  contact: string
  /** null = every city (`*`). */
  cities: string[] | null
  /** `roles`: only keys with a role from an anchor (or anchors) write. */
  writePolicy: 'open' | 'roles'
  /** Pubkeys whose `roles` lists the relay follows (docs/spec/04, TRUST-4). */
  trustAnchors: string[]
  /** NIP-13 leading zero bits asked of `report` events from keys without a role (SPAM-1). 0 disables it. */
  powBitsReport: number
  rateEventsPerMin: number
  retentionDays: number
  /** 0 disables the age limit (RELAY-5). */
  maxEventAgeDays: number
}

// Per IP the limit is wider than per pubkey: one gateway or one NAT can carry many sources.
export const IP_RATE_FACTOR = 10

function int(value: string | undefined, fallback: number): number {
  const n = Number(value)
  return value !== undefined && value !== '' && Number.isSafeInteger(n) && n >= 0 ? n : fallback
}

export function readConfig(vars: RelayVars): Config {
  const cities = (vars.CITIES ?? ANY_CITY)
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c !== '')
  const policy = vars.WRITE_POLICY || 'open'
  if (policy !== 'open' && policy !== 'roles') throw new Error(`WRITE_POLICY=${policy}: expected "open" or "roles"`)
  const trustAnchors = (vars.TRUST_ANCHORS ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k !== '')
  const bad = trustAnchors.find((k) => !isHex64(k))
  if (bad) throw new Error(`TRUST_ANCHORS: not a hex pubkey: ${bad}`)
  if (policy === 'roles' && trustAnchors.length === 0) throw new Error('WRITE_POLICY=roles needs TRUST_ANCHORS')
  return {
    name: vars.RELAY_NAME || 'SmartCity relay',
    contact: vars.RELAY_CONTACT ?? '',
    cities: cities.length === 0 || cities.includes(ANY_CITY) ? null : cities,
    writePolicy: policy,
    trustAnchors,
    powBitsReport: Math.min(int(vars.POW_BITS_REPORT, 16), 32),
    rateEventsPerMin: int(vars.RATE_EVENTS_PER_MIN, 60),
    retentionDays: int(vars.RETENTION_DAYS, 90),
    maxEventAgeDays: int(vars.MAX_EVENT_AGE_DAYS, 30),
  }
}
