import { CITIES, SEED_RELAYS } from './config'

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
}

export const SETTINGS_KEY = 'sc.settings'

export const defaults = (): Settings => ({ city: CITIES[0]!.id, relays: [...SEED_RELAYS], anchors: {} })

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === 'string')

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
  return { city, relays, anchors }
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
