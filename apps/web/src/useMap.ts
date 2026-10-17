import type { BBox, City } from '@smartcity/sdk'
import { Map as MapLibreMap, type StyleSpecification } from 'maplibre-gl'
import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import { useApp } from './client'
import { GEO } from './config'
import { getPlace, subscribePlace, usePlace } from './geo/store'
import { mapStyle, registerLocalTiles } from './maplib'

const darkScheme = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false

/**
 * APP-16: the city's own basemap while the place is inside the city; elsewhere, or without one, the optional world
 * basemap of `GEO`; with neither, a plain background.
 */
function basemap(tiles: string | null, covered: boolean): string | StyleSpecification {
  const dark = darkScheme()
  if (tiles && covered) return mapStyle(tiles, dark)
  const world = dark ? GEO.worldStyleDark : GEO.worldStyle
  return world || mapStyle(tiles, dark)
}

/** First `https:` URL of the city's tiles. Other schemes (ipfs:, magnet) need a gateway or a local copy. */
export function cityTiles(city: City | null): string | null {
  return city?.content.tiles?.urls?.find((u) => u.startsWith('https://')) ?? null
}

export function intersect(a: BBox, b: BBox): BBox | null {
  const box: BBox = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]
  return box[0] <= box[2] && box[1] <= box[3] ? box : null
}

/**
 * A map of the city over its basemap (or a plain background). `addLayers` runs on every style load, since a new
 * basemap drops the data layers. Returns the map, whether its style is ready, and the visible box.
 */
export function useCityMap(container: RefObject<HTMLDivElement | null>, tiles: string | null, addLayers: (map: MapLibreMap) => void) {
  const { city, cityConfig } = useApp()
  const mapRef = useRef<MapLibreMap | null>(null)
  const [ready, setReady] = useState(false)
  const [view, setView] = useState<BBox | null>(null)
  const cityBox = city?.content.bbox ?? cityConfig.bbox
  // APP-15: a place already chosen or detected sets the first view.
  const startBox = getPlace()?.place.bbox ?? cityBox
  const placeBox = usePlace()?.place.bbox
  const covered = !placeBox || intersect(placeBox, cityBox) !== null
  const layers = useRef(addLayers)
  layers.current = addLayers

  // Created once.
  useEffect(() => {
    const [minLat, minLon, maxLat, maxLon] = startBox
    const map = new MapLibreMap({
      container: container.current!,
      style: basemap(tiles, covered),
      bounds: [
        [minLon, minLat],
        [maxLon, maxLat],
      ],
      attributionControl: { compact: true },
    })
    mapRef.current = map
    map.on('style.load', () => {
      layers.current(map)
      setReady(true)
    })
    const updateView = () => {
      const b = map.getBounds()
      setView([b.getSouth(), b.getWest(), b.getNorth(), b.getEast()])
    }
    map.on('load', updateView)
    map.on('moveend', updateView)
    // APP-15: go to each new place.
    const stopPlace = subscribePlace(() => {
      const box = getPlace()?.place.bbox
      if (box) map.fitBounds([[box[1], box[0]], [box[3], box[2]]], { duration: 1200 })
    })
    return () => {
      stopPlace()
      map.remove()
      mapRef.current = null
      setReady(false)
    }
  }, [])

  // Basemap when the tiles become known (city definition or a local file) or the place leaves or enters the city.
  // The map starts with the current ones.
  const styledWith = useRef(`${tiles}|${covered}`)
  useEffect(() => {
    const key = `${tiles}|${covered}`
    if (styledWith.current === key) return
    styledWith.current = key
    mapRef.current?.setStyle(basemap(tiles, covered))
  }, [tiles, covered])

  return { map: mapRef, ready, view, cityBox }
}

// A local PMTiles file opened by the user serves every map of the session.
let localTiles: string | null = null
const tileListeners = new Set<() => void>()

export function openLocalTiles(file: File): void {
  localTiles = registerLocalTiles(file)
  tileListeners.forEach((l) => l())
}

/** The basemap in use: a local file if one was opened, otherwise the city's, otherwise the one of the build. */
export function useTiles(): string | null {
  const { city, cityConfig } = useApp()
  const local = useSyncExternalStore(
    (l) => {
      tileListeners.add(l)
      return () => tileListeners.delete(l)
    },
    () => localTiles,
  )
  return local ?? cityTiles(city) ?? cityConfig.tiles ?? null
}
