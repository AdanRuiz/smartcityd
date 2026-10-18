import { isCityId } from '@smartcity/schemas'
import type { BBox } from '@smartcity/sdk'
import { CITIES, type CityConfig } from './config'
import type { Place } from './geo/places'

// APP-17: the city of the data (tag `c`, anchors, local store) follows the city chosen on the map (ADR-25).

const inside = (b: BBox, lat: number, lon: number) => lat >= b[0] && lat <= b[2] && lon >= b[1] && lon <= b[3]

/** EVT-1: `<ISO 3166-1 alpha-2>-<slug of the name>`, lowercase `[a-z0-9-]`, at most 32 characters. */
export function cityIdFor(countryCode: string, name: string): string | null {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 29)
    .replace(/^-+|-+$/g, '')
  const id = `${countryCode.trim().toLowerCase()}-${slug}`
  return isCityId(id) ? id : null
}

/**
 * APP-17: a city of the build whose area contains the place keeps its id and roots (TRUST-1); any other city gets
 * an id from its country and name, with no roots: its anchors are chosen in the app (TRUST-3). Null when the place
 * has no country code or name to build an id from.
 */
export function cityForPlace(place: Place, cities: CityConfig[] = CITIES): CityConfig | null {
  const known = cities.find((c) => inside(c.bbox, place.lat, place.lon))
  if (known) return known
  const id = place.countryCode ? cityIdFor(place.countryCode, place.name) : null
  if (!id) return null
  return cities.find((c) => c.id === id) ?? { id, name: place.name, roots: [], bbox: place.bbox }
}
