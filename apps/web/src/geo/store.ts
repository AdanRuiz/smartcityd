import { useSyncExternalStore } from 'react'
import { readItem, writeItem } from '../settings'
import { locateByBrowser, locateByIp, type Place } from './places'

// The place on the map (APP-12 to APP-15). How it was chosen sets what may replace it: a choice of the user is
// never overwritten by detection, and the browser's position refines the IP's guess.

export type PlaceSource = 'ip' | 'browser' | 'manual'

export interface CurrentPlace {
  place: Place
  source: PlaceSource
}

export const PLACE_KEY = 'sc.place'
const RANK: Record<PlaceSource, number> = { ip: 0, browser: 1, manual: 2 }

/** A choice of the user as saved (APP-15), or null if `saved` is not one. */
export function parseSavedPlace(saved: unknown): CurrentPlace | null {
  if (!saved || typeof saved !== 'object') return null
  const { place, source } = saved as Partial<CurrentPlace>
  if (source !== 'manual' || !place || typeof place !== 'object') return null
  const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n)
  const valid =
    typeof place.name === 'string' && finite(place.lat) && finite(place.lon) && Array.isArray(place.bbox) && place.bbox.length === 4 && place.bbox.every(finite)
  return valid ? { place, source } : null
}

function load(): CurrentPlace | null {
  try {
    return parseSavedPlace(JSON.parse(readItem(PLACE_KEY) ?? 'null'))
  } catch {
    return null
  }
}

let current: CurrentPlace | null = load()
const listeners = new Set<() => void>()

export function getPlace(): CurrentPlace | null {
  return current
}

/** Sets the place unless a better source already chose one; a manual choice always wins and is remembered. */
export function setPlace(place: Place, source: PlaceSource): void {
  if (current && source !== 'manual' && RANK[current.source] > RANK[source]) return
  current = { place, source }
  // Only a choice of the user is kept (APP-15): detection runs again on the next visit.
  if (source === 'manual') writeItem(PLACE_KEY, JSON.stringify(current))
  listeners.forEach((l) => l())
}

export function subscribePlace(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function usePlace(): CurrentPlace | null {
  return useSyncExternalStore(subscribePlace, getPlace)
}

let started = false

/**
 * APP-12, APP-13: once per page load and only without a saved choice, the IP's city first (fast, no prompt) and
 * then the browser's position, which asks the user for permission. Both are optional and fail silently.
 */
export function startAutoLocate(): void {
  if (started || current?.source === 'manual') return
  started = true
  void locateByIp().then((p) => p && setPlace(p, 'ip'))
  void locateByBrowser().then((p) => p && setPlace(p, 'browser'))
}
