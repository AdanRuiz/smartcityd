import { GEOHASH_PRECISIONS } from '@smartcity/schemas'

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz'

/** `[lat, lon]`, WGS84 (EVT-4). */
export type LatLon = [number, number]

/** `[minLat, minLon, maxLat, maxLon]`, the order of `bbox` in a `city` definition. */
export type BBox = [number, number, number, number]

export function encodeGeohash(lat: number, lon: number, precision: number): string {
  let latMin = -90
  let latMax = 90
  let lonMin = -180
  let lonMax = 180
  let hash = ''
  let bits = 0
  let value = 0
  let even = true // geohash starts with longitude
  while (hash.length < precision) {
    if (even) {
      const mid = (lonMin + lonMax) / 2
      if (lon >= mid) {
        value = value * 2 + 1
        lonMin = mid
      } else {
        value *= 2
        lonMax = mid
      }
    } else {
      const mid = (latMin + latMax) / 2
      if (lat >= mid) {
        value = value * 2 + 1
        latMin = mid
      } else {
        value *= 2
        latMax = mid
      }
    }
    even = !even
    if (++bits === 5) {
      hash += BASE32[value]
      bits = 0
      value = 0
    }
  }
  return hash
}

/** EVT-3: the three `g` tags (precision 4, 5 and 6) of a point. */
export function geoTags([lat, lon]: LatLon): string[][] {
  const finest = encodeGeohash(lat, lon, Math.max(...GEOHASH_PRECISIONS))
  return GEOHASH_PRECISIONS.map((p) => ['g', finest.slice(0, p)])
}

/** Size in degrees of a geohash cell: [height (lat), width (lon)]. */
function cellSize(precision: number): [number, number] {
  const bits = precision * 5
  const lonBits = Math.ceil(bits / 2)
  const latBits = Math.floor(bits / 2)
  return [180 / 2 ** latBits, 360 / 2 ** lonBits]
}

function cellsAt([minLat, minLon, maxLat, maxLon]: BBox, precision: number, max: number): string[] | null {
  const [h, w] = cellSize(precision)
  const rows = Math.floor((maxLat + 90) / h) - Math.floor((minLat + 90) / h) + 1
  const cols = Math.floor((maxLon + 180) / w) - Math.floor((minLon + 180) / w) + 1
  if (rows * cols > max) return null
  const cells: string[] = []
  const lat0 = (Math.floor((minLat + 90) / h) + 0.5) * h - 90
  const lon0 = (Math.floor((minLon + 180) / w) + 0.5) * w - 180
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) cells.push(encodeGeohash(Math.min(lat0 + r * h, 90), Math.min(lon0 + c * w, 180), precision))
  }
  return cells
}

/** Cells that one filter may carry; the reference relay accepts 80 values per filter (docs/spec/07). */
export const MAX_CELLS = 48

/**
 * SDK-6: geohash cells that cover `bbox`, at the finest precision (6, 5 or 4) that needs at most `max` cells.
 * When even precision 4 needs more, returns precision 4 cells anyway; the caller splits them into several
 * filters. The result is a superset of the box: clip with `inBBox` afterwards.
 */
export function coverBBox(bbox: BBox, max = MAX_CELLS): { precision: number; cells: string[] } {
  const [minLat, minLon, maxLat, maxLon] = bbox
  if (!(minLat <= maxLat && minLon <= maxLon)) throw new RangeError('bbox must be [minLat, minLon, maxLat, maxLon]')
  const finestFirst = [...GEOHASH_PRECISIONS].sort((a, b) => b - a)
  for (const precision of finestFirst) {
    const cells = cellsAt(bbox, precision, max)
    if (cells) return { precision, cells }
  }
  const coarsest = finestFirst[finestFirst.length - 1]!
  return { precision: coarsest, cells: cellsAt(bbox, coarsest, Infinity)! }
}

export function inBBox([lat, lon]: LatLon, [minLat, minLon, maxLat, maxLon]: BBox): boolean {
  return lat >= minLat && lat <= maxLat && lon >= minLon && lon <= maxLon
}

/** EVT-4: at most 6 decimals. */
export function roundCoord(value: number, decimals = 6): number {
  return Number(value.toFixed(decimals))
}
