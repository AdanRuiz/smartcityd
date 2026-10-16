import type { BBox } from '@smartcity/sdk'

// APP-5: initial configuration embedded in the build; the user changes it in the app (stored per origin, APP-11).

export interface CityConfig {
  id: string
  name: string
  /**
   * TRUST-1: root keys of the city. Empty until the pilot custodians are designated (TRUST-11); while empty the
   * app does not pick a `city` definition on its own (TRUST-3) and uses `bbox` and the seed relays.
   */
  roots: string[]
  /** Used for the initial view until the `city` definition is known. */
  bbox: BBox
  /** Dataset shown first (`31481:<pubkey>:<d>`). Optional. */
  dataset?: string
}

export const SEED_RELAYS = ['wss://smartcity-relay.adan0001.workers.dev', 'wss://smartcity-relay-b.adan0001.workers.dev']

export const CITIES: CityConfig[] = [
  {
    id: 'mx-gdl',
    name: 'Guadalajara',
    roots: [],
    bbox: [20.55, -103.47, 20.78, -103.24],
  },
]
