import type { BBox, City, Dataset, Reading } from '@smartcity/sdk'
import { Map as MapLibreMap, type GeoJSONSource } from 'maplibre-gl'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '../client'
import { mapStyle, registerLocalTiles } from '../maplib'

const WINDOW_S = 24 * 3600
const SOURCE = 'readings'
// Sequential ramp, low → high.
const RAMP = ['#2a9d8f', '#8ab17d', '#e9c46a', '#f4a261', '#e76f51', '#9b2226']

const darkScheme = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false

/** First `https:` URL of the city's tiles. Other schemes (ipfs:, magnet) need a gateway or a local copy. */
function cityTiles(city: City | null): string | null {
  return city?.content.tiles?.urls?.find((u) => u.startsWith('https://')) ?? null
}

function intersect(a: BBox, b: BBox): BBox | null {
  const box: BBox = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]
  return box[0] <= box[2] && box[1] <= box[3] ? box : null
}

function readingKey(r: Reading): string {
  return r.source ?? `${r.pubkey}:${r.loc?.join(',') ?? ''}`
}

function addDataLayers(map: MapLibreMap) {
  if (map.getSource(SOURCE)) return
  map.addSource(SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
  map.addLayer({
    id: SOURCE,
    type: 'circle',
    source: SOURCE,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 5, 15, 11],
      'circle-color': ['coalesce', ['get', 'color'], '#888'],
      'circle-stroke-width': 1.5,
      'circle-stroke-color': '#ffffff',
    },
  })
}

function colorFor(value: unknown, min: number, max: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '#888888'
  const t = max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0.5
  return RAMP[Math.min(RAMP.length - 1, Math.floor(t * RAMP.length))]!
}

export function MapPage() {
  const { sc, cityConfig, city } = useApp()
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const [ready, setReady] = useState(false)
  const [view, setView] = useState<BBox | null>(null)
  const [datasets, setDatasets] = useState<Dataset[] | null>(null)
  const [address, setAddress] = useState<string | undefined>(cityConfig.dataset)
  const [field, setField] = useState<string | undefined>()
  const [latest, setLatest] = useState<ReadonlyMap<string, Reading>>(new Map())
  const [selected, setSelected] = useState<string | null>(null)
  const [localTiles, setLocalTiles] = useState<string | null>(null)
  const [lastEvent, setLastEvent] = useState<number | null>(null)
  const cityBox = city?.content.bbox ?? cityConfig.bbox
  const tiles = localTiles ?? cityTiles(city)

  // Map, created once.
  useEffect(() => {
    const [minLat, minLon, maxLat, maxLon] = cityBox
    const map = new MapLibreMap({
      container: container.current!,
      style: mapStyle(tiles, darkScheme()),
      bounds: [
        [minLon, minLat],
        [maxLon, maxLat],
      ],
      attributionControl: { compact: true },
    })
    mapRef.current = map
    map.on('style.load', () => {
      addDataLayers(map)
      setReady(true)
    })
    const updateView = () => {
      const b = map.getBounds()
      setView([b.getSouth(), b.getWest(), b.getNorth(), b.getEast()])
    }
    map.on('load', updateView)
    map.on('moveend', updateView)
    map.on('click', SOURCE, (e) => setSelected((e.features?.[0]?.properties?.key as string | undefined) ?? null))
    map.on('mouseenter', SOURCE, () => (map.getCanvas().style.cursor = 'pointer'))
    map.on('mouseleave', SOURCE, () => (map.getCanvas().style.cursor = ''))
    return () => {
      map.remove()
      mapRef.current = null
      setReady(false)
    }
  }, [])

  // Basemap when the tiles become known (city definition or a local file). The map starts with the current ones.
  const styledWith = useRef(tiles)
  useEffect(() => {
    if (styledWith.current === tiles) return
    styledWith.current = tiles
    mapRef.current?.setStyle(mapStyle(tiles, darkScheme()))
  }, [tiles])

  // Datasets of the city with points (catalogue).
  useEffect(() => {
    let alive = true
    sc.datasets.list().then((list) => {
      if (!alive) return
      const usable = list.filter((d) => d.content.mode === 'observation' && d.content.geometry === 'point')
      setDatasets(usable)
      setAddress((a) => a ?? usable[0]?.address)
    }, () => alive && setDatasets([]))
    return () => {
      alive = false
    }
  }, [sc, city])

  const dataset = datasets?.find((d) => d.address === address) ?? null
  const numericFields = useMemo(
    () => Object.entries(dataset?.content.fields ?? {}).filter(([, f]) => f.type === 'number' || f.type === 'integer'),
    [dataset],
  )
  const fieldName = field && numericFields.some(([n]) => n === field) ? field : numericFields[0]?.[0]
  const fieldSpec = fieldName ? dataset?.content.fields[fieldName] : undefined

  // Subscription for the visible part of the city (SDK-6). Stored readings first, then live (NFR-1).
  const box = view ? intersect(view, cityBox) : null
  const boxKey = box?.map((n) => n.toFixed(3)).join(',')
  useEffect(() => {
    if (!address || !box) return
    const pending = new Map<string, Reading>()
    let timer: ReturnType<typeof setTimeout> | null = null
    const flush = () => {
      timer = null
      setLatest((prev) => {
        const next = new Map(prev)
        for (const [k, r] of pending) if ((next.get(k)?.ts ?? -1) < r.ts) next.set(k, r)
        pending.clear()
        return next
      })
    }
    const close = sc.observations.subscribe({ dataset: address, bbox: box, since: Math.floor(Date.now() / 1000) - WINDOW_S }, (r) => {
      const k = readingKey(r)
      if ((pending.get(k)?.ts ?? -1) < r.ts) pending.set(k, r)
      setLastEvent(Date.now())
      timer ??= setTimeout(flush, 150)
    })
    return () => {
      close()
      if (timer) clearTimeout(timer)
    }
  }, [sc, address, boxKey])

  // A different dataset starts from an empty map.
  useEffect(() => {
    setLatest(new Map())
    setSelected(null)
  }, [address])

  // Readings → GeoJSON.
  const values = [...latest.values()].map((r) => (fieldName ? r.values[fieldName] : undefined)).filter((v) => typeof v === 'number')
  // Range of what is on screen; the dataset limits (often very wide) only when there is no data.
  const min = values.length ? Math.min(...values) : (fieldSpec?.min ?? 0)
  const max = values.length ? Math.max(...values) : (fieldSpec?.max ?? 1)
  useEffect(() => {
    const source = mapRef.current?.getSource(SOURCE) as GeoJSONSource | undefined
    if (!ready || !source) return
    source.setData({
      type: 'FeatureCollection',
      features: [...latest.entries()]
        .filter(([, r]) => r.loc)
        .map(([key, r]) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [r.loc![1], r.loc![0]] },
          properties: { key, color: colorFor(fieldName ? r.values[fieldName] : undefined, min, max) },
        })),
    })
  }, [ready, latest, fieldName, min, max])

  const picked = selected ? latest.get(selected) : undefined

  return (
    <div className="map-page">
      <div ref={container} className="map" />
      <aside className="panel">
        <label>
          Dataset
          <select value={address ?? ''} onChange={(e) => setAddress(e.target.value || undefined)}>
            {datasets === null && <option value="">Cargando…</option>}
            {datasets?.length === 0 && <option value="">Sin datasets en los relays</option>}
            {datasets?.map((d) => (
              <option key={d.address} value={d.address}>
                {d.content.name} · {d.pubkey.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
        {numericFields.length > 1 && (
          <label>
            Campo
            <select value={fieldName} onChange={(e) => setField(e.target.value)}>
              {numericFields.map(([name, f]) => (
                <option key={name} value={name}>
                  {name}
                  {f.unit ? ` (${f.unit})` : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        {fieldName && (
          <div className="legend">
            <div className="ramp" />
            <div className="ramp-labels">
              <span>{fmt(min)}</span>
              <span>{fieldSpec?.unit ?? ''}</span>
              <span>{fmt(max)}</span>
            </div>
          </div>
        )}
        <p className="muted">
          {latest.size} {latest.size === 1 ? 'fuente' : 'fuentes'} en las últimas 24 h
          {lastEvent ? ` · último dato ${new Date(lastEvent).toLocaleTimeString()}` : ''}
        </p>
        {picked && (
          <div className="card">
            <div className="muted">{new Date(picked.ts * 1000).toLocaleString()}</div>
            <table>
              <tbody>
                {Object.entries(picked.values).map(([k, v]) => (
                  <tr key={k}>
                    <th>{k}</th>
                    <td>
                      {String(v)} {dataset?.content.fields[k]?.unit ?? ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {picked.q !== 'ok' && <div className="muted">Calidad: {picked.q}</div>}
            <div className="muted mono">Fuente: {picked.source ?? picked.pubkey}</div>
          </div>
        )}
        {!tiles && (
          <label className="file">
            Sin mapa base.{' '}
            <span className="link">Abrir archivo .pmtiles</span>
            <input
              type="file"
              accept=".pmtiles"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) setLocalTiles(registerLocalTiles(file))
              }}
            />
          </label>
        )}
      </aside>
    </div>
  )
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}
