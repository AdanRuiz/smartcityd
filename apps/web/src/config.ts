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
  /**
   * Basemap (PMTiles over HTTPS) used until the city definition announces its own `tiles` (APP-5). A mirror, not a
   * dependency: without it the map shows a plain background and a local file can be opened.
   */
  tiles?: string
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
    // services/tiles-worker: OpenStreetMap extract of 2026-10-15, sha256 07e25b6c…5254939.
    tiles: 'https://smartcity-tiles.adan0001.workers.dev/mx-gdl/20261015.pmtiles',
  },
]

/**
 * APP-12 to APP-14: public services for locating the user and searching cities. All optional (empty string turns
 * one off) and free without a key; if they fail the app keeps the configured city. Swap them for any service with
 * the same response format (geojs.io for the IP, Photon for search and reverse lookup).
 */
export const GEO = {
  ipUrl: 'https://get.geojs.io/v1/ip/geo.json',
  searchUrl: 'https://photon.komoot.io/api/',
  /** APP-16: world basemap (OpenFreeMap, free and without a key) where the city has no tiles of its own. */
  worldStyle: 'https://tiles.openfreemap.org/styles/positron',
  worldStyleDark: 'https://tiles.openfreemap.org/styles/dark',
  reverseUrl: 'https://photon.komoot.io/reverse',
  suggestions: 6,
  debounceMs: 300,
  timeoutMs: 8000,
}
