import { CITIES, SEED_RELAYS } from './config'

// User settings (APP-5). localStorage can be missing or throw (private mode, file:// in some browsers):
// the app then keeps working with the embedded configuration.

export interface Settings {
  city: string
  relays: string[]
  /** TRUST-2: anchors chosen by the user for the city; null uses the roots of the build (TRUST-1). */
  anchors: string[] | null
}

const KEY = 'sc.settings'

export const defaults = (): Settings => ({ city: CITIES[0]!.id, relays: [...SEED_RELAYS], anchors: null })

export function loadSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Settings> | null
    return { ...defaults(), ...(saved ?? {}) }
  } catch {
    return defaults()
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings))
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
