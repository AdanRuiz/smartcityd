import { CITIES, DEVELOPERS, SEED_RELAYS } from './config'

// User settings (APP-5). localStorage can be missing or throw (private mode, file:// in some browsers):
// the app then keeps working with the embedded configuration.

export interface Settings {
  /** City of the data until the place on the map gives one (APP-17). */
  city: string
  relays: string[]
  /**
   * TRUST-2, APP-18: anchors chosen by the user, by city id. A city without an entry uses the roots of the build
   * (TRUST-1), or none.
   */
  anchors: Record<string, string[]>
  /**
   * APP-5, APP-8: developer keys whose `release` the app believes. By default those embedded in the build; a user who
   * checks the source of another build can replace them, and an empty list turns the notice off.
   */
  developers: string[]
}

export const SETTINGS_KEY = 'sc.settings'

export const defaults = (): Settings => ({ city: CITIES[0]!.id, relays: [...SEED_RELAYS], anchors: {}, developers: [...DEVELOPERS] })

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === 'string')

const HEX64 = /^[0-9a-f]{64}$/

/** Saved settings over the defaults. Before APP-18 the anchors were one list, for the city then saved. */
export function parseSettings(saved: unknown): Settings {
  const base = defaults()
  if (!saved || typeof saved !== 'object') return base
  const s = saved as Record<string, unknown>
  const city = typeof s.city === 'string' ? s.city : base.city
  const relays = strings(s.relays) ? s.relays : base.relays
  let anchors: Record<string, string[]> = {}
  if (strings(s.anchors)) anchors = { [city]: s.anchors }
  else if (s.anchors && typeof s.anchors === 'object')
    anchors = Object.fromEntries(Object.entries(s.anchors).filter((e): e is [string, string[]] => strings(e[1])))
  // An empty list is a choice of the user (no notice); invalid keys are dropped.
  const developers = strings(s.developers) ? [...new Set(s.developers.filter((pk) => HEX64.test(pk)))] : base.developers
  return { city, relays, anchors, developers }
}

export function loadSettings(): Settings {
  try {
    return parseSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null'))
  } catch {
    return defaults()
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    // not persisted; the change still applies to this session
  }
}

export function readItem(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeItem(key: string, value: string | null): boolean {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}
