import { ANY_CITY } from '@smartcity/schemas'

/** Variables of wrangler.toml (docs/spec/07, "Configuración"). All optional strings, as Workers passes them. */
export interface RelayVars {
  RELAY_NAME?: string
  RELAY_CONTACT?: string
  CITIES?: string
  WRITE_POLICY?: string
  RATE_EVENTS_PER_MIN?: string
  RETENTION_DAYS?: string
  MAX_EVENT_AGE_DAYS?: string
}

export interface Config {
  name: string
  contact: string
  /** null = every city (`*`). */
  cities: string[] | null
  writePolicy: 'open'
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
  const policy = vars.WRITE_POLICY ?? 'open'
  if (policy !== 'open') throw new Error(`WRITE_POLICY=${policy} is not implemented yet (phase 3); use "open"`)
  return {
    name: vars.RELAY_NAME || 'SmartCity relay',
    contact: vars.RELAY_CONTACT ?? '',
    cities: cities.length === 0 || cities.includes(ANY_CITY) ? null : cities,
    writePolicy: policy,
    rateEventsPerMin: int(vars.RATE_EVENTS_PER_MIN, 60),
    retentionDays: int(vars.RETENTION_DAYS, 90),
    maxEventAgeDays: int(vars.MAX_EVENT_AGE_DAYS, 30),
  }
}
