import { ALLOWED_KINDS, ANY_CITY, KIND, MAX_FUTURE_SECONDS, isSystemKind, kindClass, tagValues, validateEvent } from '@smartcity/schemas'
import { getPow } from 'nostr-tools/nip13'

export interface PolicyConfig {
  /** null = every city. */
  cities: string[] | null
  /** RELAY-5; 0 disables it. */
  maxEventAgeDays: number
  /** SPAM-1: bits asked of every `report` (this plugin does not know roles); 0 disables it. */
  powBitsReport: number
}

const int = (value: string | undefined, fallback: number) => {
  const n = Number(value)
  return value !== undefined && value !== '' && Number.isSafeInteger(n) && n >= 0 ? n : fallback
}

export function readPolicyConfig(env: Record<string, string | undefined>): PolicyConfig {
  const cities = (env.CITIES ?? ANY_CITY).split(',').map((c) => c.trim()).filter(Boolean)
  return {
    cities: cities.length === 0 || cities.includes(ANY_CITY) ? null : cities,
    maxEventAgeDays: int(env.MAX_EVENT_AGE_DAYS, 30),
    powBitsReport: Math.min(int(env.POW_BITS_REPORT, 16), 32),
  }
}

interface Candidate {
  id: string
  kind: number
  created_at: number
  tags: string[][]
  content: string
  pubkey: string
}

/**
 * Steps 2, 3, 7, 8 and the city part of 9 of docs/spec/07, with the same prefixes. Returns the rejection message,
 * or null to accept. `now` in seconds.
 */
export function decide(raw: unknown, config: PolicyConfig, now: number): string | null {
  const event = raw as Candidate
  if (typeof event !== 'object' || event === null || !Number.isInteger(event.kind)) return 'invalid: not an event'
  if (!ALLOWED_KINDS.includes(event.kind)) return `blocked: kind ${event.kind} is not accepted by this relay`
  if (event.created_at > now + MAX_FUTURE_SECONDS) return 'invalid: created_at is too far in the future'
  if (kindClass(event.kind) === 'regular' && config.maxEventAgeDays > 0 && event.created_at < now - config.maxEventAgeDays * 86_400) {
    return 'invalid: too old'
  }
  if (isSystemKind(event.kind)) {
    const result = validateEvent(event)
    if (!result.ok) return `invalid: ${result.errors.join('; ')}`
  }
  if (event.kind === KIND.REPORT && config.powBitsReport > 0 && getPow(event.id) < config.powBitsReport) {
    return `pow: difficulty ${config.powBitsReport} required`
  }
  const city = event.kind === KIND.CITY ? tagValues(event.tags, 'd')[0] : tagValues(event.tags, 'c')[0]
  if (config.cities && city && city !== ANY_CITY && !config.cities.includes(city)) {
    return `restricted: city ${city} is not served by this relay`
  }
  return null
}
