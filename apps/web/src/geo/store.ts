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

const KEY = 'sc.place'
const RANK: Record<PlaceSource, number> = { ip: 0, browser: 1, manual: 2 }

function load(): CurrentPlace | null {
  try {
    const saved = JSON.parse(readItem(KEY) ?? 'null') as CurrentPlace | null
    return saved?.place && Array.isArray(saved.place.bbox) && saved.source === 'manual' ? saved : null
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
  if (source === 'manual') writeItem(KEY, JSON.stringify(current))
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
