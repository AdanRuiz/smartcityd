import type { Dataset, Reading, TrustLevel } from '@smartcity/sdk'
import type { GeoJSONSource, Map as MapLibreMap, MapLayerMouseEvent } from 'maplibre-gl'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '../client'
import { BasemapPicker, DEFAULT_LEVELS, TrustBadge, TrustFilter } from '../components'
import { intersect, useCityMap, useTiles } from '../useMap'

const WINDOW_S = 24 * 3600
const SOURCE = 'readings'
// Sequential ramp, low → high.
const RAMP = ['#2a9d8f', '#8ab17d', '#e9c46a', '#f4a261', '#e76f51', '#9b2226']

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
      // docs/spec/04: `verified` is shown with a mark.
      'circle-stroke-width': ['case', ['get', 'verified'], 3, 1.5],
      'circle-stroke-color': ['case', ['get', 'verified'], '#1d4ed8', '#ffffff'],
    },
  })
}

function colorFor(value: unknown, min: number, max: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '#888888'
  const t = max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0.5
  return RAMP[Math.min(RAMP.length - 1, Math.floor(t * RAMP.length))]!
}

export function MapPage() {
  const { sc, cityConfig, city, trustVersion } = useApp()
  const container = useRef<HTMLDivElement>(null)
  const tiles = useTiles()
  const { map, ready, view, cityBox } = useCityMap(container, tiles, addDataLayers)
  const [datasets, setDatasets] = useState<Dataset[] | null>(null)
  const [address, setAddress] = useState<string | undefined>(cityConfig.dataset)
  const [field, setField] = useState<string | undefined>()
  const [latest, setLatest] = useState<ReadonlyMap<string, Reading>>(new Map())
  const [selected, setSelected] = useState<string | null>(null)
  const [lastEvent, setLastEvent] = useState<number | null>(null)
  const [levels, setLevels] = useState<TrustLevel[]>(DEFAULT_LEVELS)

  useEffect(() => {
    const m = map.current
    if (!m) return
    const click = (e: MapLayerMouseEvent) => setSelected((e.features?.[0]?.properties?.key as string | undefined) ?? null)
    const enter = () => (m.getCanvas().style.cursor = 'pointer')
    const leave = () => (m.getCanvas().style.cursor = '')
    m.on('click', SOURCE, click)
    m.on('mouseenter', SOURCE, enter)
    m.on('mouseleave', SOURCE, leave)
    return () => {
      m.off('click', SOURCE, click)
      m.off('mouseenter', SOURCE, enter)
      m.off('mouseleave', SOURCE, leave)
    }
  }, [map])

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

  // TRUST-5, TRUST-7: the level is computed now, with the lists known now.
  const shown = useMemo(() => {
    const out = new Map<string, { reading: Reading; level: TrustLevel }>()
    for (const [k, r] of latest) {
      const level = sc.trust.levelOf(r)
      if (levels.includes(level)) out.set(k, { reading: r, level })
    }
    return out
  }, [sc, latest, levels, trustVersion])

  // Range of what is on screen; the dataset limits (often very wide) only when there is no data.
  const values = [...shown.values()].map(({ reading }) => (fieldName ? reading.values[fieldName] : undefined)).filter((v) => typeof v === 'number')
  const min = values.length ? Math.min(...values) : (fieldSpec?.min ?? 0)
  const max = values.length ? Math.max(...values) : (fieldSpec?.max ?? 1)
  useEffect(() => {
    const source = map.current?.getSource(SOURCE) as GeoJSONSource | undefined
    if (!ready || !source) return
    source.setData({
      type: 'FeatureCollection',
      features: [...shown.entries()]
        .filter(([, { reading }]) => reading.loc)
        .map(([key, { reading: r, level }]) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [r.loc![1], r.loc![0]] },
          properties: { key, color: colorFor(fieldName ? r.values[fieldName] : undefined, min, max), verified: level === 'verified' },
        })),
    })
  }, [ready, shown, fieldName, min, max])

  const picked = selected ? shown.get(selected) : undefined
  const hidden = latest.size - shown.size

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
        <TrustFilter value={levels} onChange={setLevels} />
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
          {shown.size} {shown.size === 1 ? 'fuente' : 'fuentes'} en las últimas 24 h
          {hidden > 0 ? ` (${hidden} ocultas por el filtro)` : ''}
          {lastEvent ? ` · último dato ${new Date(lastEvent).toLocaleTimeString()}` : ''}
        </p>
        {picked && (
          <div className="card">
            <div className="row-between">
              <span className="muted">{new Date(picked.reading.ts * 1000).toLocaleString()}</span>
              <TrustBadge level={picked.level} />
            </div>
            <table>
              <tbody>
                {Object.entries(picked.reading.values).map(([k, v]) => (
                  <tr key={k}>
                    <th>{k}</th>
                    <td>
                      {String(v)} {dataset?.content.fields[k]?.unit ?? ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {picked.reading.q !== 'ok' && <div className="muted">Calidad: {picked.reading.q}</div>}
            <div className="muted mono">Fuente: {picked.reading.source ?? picked.reading.pubkey}</div>
          </div>
        )}
        {!tiles && <BasemapPicker />}
      </aside>
    </div>
  )
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}
