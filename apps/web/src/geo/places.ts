import type { BBox } from '@smartcity/sdk'
import { GEO } from '../config'

// Where the user is and which cities match a name (APP-12 to APP-15). Every lookup goes to an optional public
// service: none is required, and any failure returns null or [] so the app keeps its configured city.

/** A city on the map: what the header shows and where the map goes. */
export interface Place {
  name: string
  /** State or region. */
  region?: string
  country?: string
  /** ISO 3166-1 alpha-2, used for the city id of the data (EVT-1, APP-17). */
  countryCode?: string
  lat: number
  lon: number
  /** `[minLat, minLon, maxLat, maxLon]`, as `BBox` in the SDK. */
  bbox: BBox
}

/** Box used when a service gives a point without an extent: about 20 km around it. */
const AROUND = 0.1

const num = (value: unknown): number | null => {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}
const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined)

export function boxAround(lat: number, lon: number, d = AROUND): BBox {
  return [lat - d, lon - d, lat + d, lon + d]
}

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal: signal ?? AbortSignal.timeout(GEO.timeoutMs), referrerPolicy: 'no-referrer' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

/** APP-12: approximate city from the IP address (geojs.io format). */
export async function locateByIp(): Promise<Place | null> {
  if (!GEO.ipUrl) return null
  try {
    const data = (await getJson(GEO.ipUrl)) as Record<string, unknown>
    const lat = num(data.latitude)
    const lon = num(data.longitude)
    const name = text(data.city)
    if (lat === null || lon === null || !name) return null
    return { name, region: text(data.region), country: text(data.country), countryCode: text(data.country_code), lat, lon, bbox: boxAround(lat, lon) }
  } catch {
    return null
  }
}

/** Photon (komoot) GeoJSON feature to a place. `extent` is `[west, north, east, south]`. */
export function photonPlace(feature: unknown): Place | null {
  const f = feature as { geometry?: { coordinates?: unknown[] }; properties?: Record<string, unknown> } | null
  const [lon, lat] = (f?.geometry?.coordinates ?? []).map(num)
  const p = f?.properties ?? {}
  const name = text(p.name) ?? text(p.city)
  if (lat == null || lon == null || !name) return null
  const e = Array.isArray(p.extent) ? p.extent.map(num) : []
  const bbox: BBox =
    e.length === 4 && e.every((v) => v !== null)
      ? [Math.min(e[1]!, e[3]!), Math.min(e[0]!, e[2]!), Math.max(e[1]!, e[3]!), Math.max(e[0]!, e[2]!)]
      : boxAround(lat, lon)
  return { name, region: text(p.state), country: text(p.country), countryCode: text(p.countrycode), lat, lon, bbox }
}

/** APP-13: city at the browser's position, with the user's permission; null if denied or unavailable. */
export async function locateByBrowser(): Promise<Place | null> {
  if (!('geolocation' in navigator)) return null
  const position = await new Promise<GeolocationPosition | null>((resolve) =>
    navigator.geolocation.getCurrentPosition(resolve, () => resolve(null), {
      timeout: GEO.timeoutMs,
      maximumAge: 10 * 60_000,
    }),
  )
  if (!position) return null
  const { latitude: lat, longitude: lon } = position.coords
  // The name comes from reverse geocoding; without it the place keeps the position and a generic label.
  let named: Place | null = null
  if (GEO.reverseUrl) {
    try {
      const data = (await getJson(`${GEO.reverseUrl}?lat=${lat}&lon=${lon}&limit=1`)) as { features?: unknown[] }
      const props = ((data.features?.[0] as { properties?: Record<string, unknown> }) ?? {}).properties ?? {}
      const name = text(props.city) ?? text(props.name)
      if (name) {
        const countryCode = text(props.countrycode)
        named = { name, region: text(props.state), country: text(props.country), countryCode, lat, lon, bbox: boxAround(lat, lon) }
      }
    } catch {
      // keep the position without a name
    }
  }
  return named ?? { name: 'Mi ubicación', lat, lon, bbox: boxAround(lat, lon) }
}

/** APP-14: cities whose name matches what the user types (Photon search, cities and towns only). */
export async function searchCities(query: string, signal: AbortSignal): Promise<Place[]> {
  const q = query.trim()
  if (!GEO.searchUrl || q.length < 2) return []
  const params = new URLSearchParams({ q, limit: String(GEO.suggestions) })
  for (const tag of ['place:city', 'place:town']) params.append('osm_tag', tag)
  const data = (await getJson(`${GEO.searchUrl}?${params}`, signal)) as { features?: unknown[] }
  const places = (data.features ?? []).map(photonPlace).filter((p): p is Place => p !== null)
  // The same city can come as several OSM objects (node and boundary): keep the first of each label.
  const seen = new Set<string>()
  return places.filter((p) => {
    const key = [p.name, p.region, p.country].join('|')
    return seen.has(key) ? false : (seen.add(key), true)
  })
}
