import type { ArchiveDiscard, Dataset, Reading, TrustLevel } from '@smartcity/sdk'
import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import { useApp } from '../client'
import { DEFAULT_LEVELS, TrustFilter } from '../components'
import {
  bucketSeconds,
  daysBetween,
  defaultRange,
  preferredArchivers,
  rangeError,
  seriesOf,
  sourcesOf,
  type Bucket,
} from '../series'

type Result = { readings: Reading[]; discarded: ArchiveDiscard[]; from: string; to: string }

/**
 * Series of a dataset field over whole UTC days, beyond the relays' retention: what the relays keep plus the
 * snapshots of those days, downloaded and verified by the SDK (docs/spec/06, SNAP-6).
 */
export function HistoryPage() {
  const { sc, cityConfig, city, trustVersion } = useApp()
  const [datasets, setDatasets] = useState<Dataset[] | null>(null)
  const [address, setAddress] = useState<string | undefined>(cityConfig.dataset)
  const [field, setField] = useState<string | undefined>()
  const [range, setRange] = useState(() => defaultRange(Date.now()))
  const [source, setSource] = useState('')
  const [levels, setLevels] = useState<TrustLevel[]>(DEFAULT_LEVELS)
  const [result, setResult] = useState<Result | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    sc.datasets.list().then((list) => {
      if (!alive) return
      const usable = list.filter((d) => d.content.mode === 'observation')
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
  const unit = fieldName ? (dataset?.content.fields[fieldName]?.unit ?? '') : ''

  // A different dataset starts empty.
  useEffect(() => {
    setResult(null)
    setSource('')
  }, [address])

  const invalid = rangeError(range.from, range.to)
  const read = async () => {
    if (!address || invalid) return
    setLoading(true)
    setError(null)
    const discarded: ArchiveDiscard[] = []
    try {
      const readings = await sc.observations.history({
        dataset: address,
        from: range.from,
        to: range.to,
        archivers: preferredArchivers(sc.trust.attested()),
        onDiscard: (d) => discarded.push(d),
      })
      setResult({ readings, discarded, ...range })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  // TRUST-5, TRUST-7: levels computed now, with the lists known now.
  const shown = useMemo(
    () =>
      (result?.readings ?? []).filter((r) => (!source || r.source === source) && levels.includes(sc.trust.levelOf(r))),
    [sc, result, source, levels, trustVersion],
  )
  const bucket = result ? bucketSeconds(daysBetween(result.from, result.to)) : 86_400
  const series = useMemo(() => (fieldName ? seriesOf(shown, fieldName, bucket) : []), [shown, fieldName, bucket])
  const sources = useMemo(() => sourcesOf(result?.readings ?? []), [result])

  return (
    <div className="page stack">
      <h1>Historial</h1>
      <p className="muted">
        Lecturas de días completos (UTC): lo que los relays aún guardan y, para los días que ya purgaron, los snapshots
        diarios que los archivistas publican, descargados de sus URLs o de IPFS y verificados evento por evento.
      </p>
      <div className="row">
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
        <label>
          Desde
          <input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
        </label>
        <label>
          Hasta
          <input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
        </label>
        <button className="primary" disabled={!address || !!invalid || loading} onClick={() => void read()}>
          {loading ? 'Leyendo…' : 'Consultar'}
        </button>
      </div>
      {invalid && <p className="error">{invalid}</p>}
      {error && <p className="error">{error}</p>}
      {result && (
        <>
          <div className="row">
            {sources.length > 1 && (
              <label>
                Fuente
                <select value={source} onChange={(e) => setSource(e.target.value)}>
                  <option value="">Todas</option>
                  {sources.map((s) => (
                    <option key={s} value={s}>
                      {s.split(':').slice(2).join(':') || s}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <TrustFilter value={levels} onChange={setLevels} />
          </div>
          <p className="muted">
            {shown.length} {shown.length === 1 ? 'lectura' : 'lecturas'} del {result.from} al {result.to}
            {shown.length < result.readings.length ? ` (${result.readings.length - shown.length} ocultas por el filtro)` : ''}
            {` · promedio, mínimo y máximo por ${bucket === 3600 ? 'hora' : 'día'} (UTC)`}
          </p>
          {fieldName && series.length > 0 ? (
            <SeriesChart series={series} bucket={bucket} title={`${fieldName}${unit ? ` (${unit})` : ''}`} unit={unit} />
          ) : (
            <p className="muted">Sin lecturas numéricas en ese rango.</p>
          )}
          {series.length > 0 && <SeriesTable series={series} bucket={bucket} unit={unit} />}
          {result.discarded.length > 0 && (
            <details className="notice">
              <summary>
                {result.discarded.length} {result.discarded.length === 1 ? 'archivo o línea descartada' : 'archivos o líneas descartadas'}{' '}
                al verificar los snapshots (SNAP-6)
              </summary>
              <ul className="plain small">
                {result.discarded.map((d, i) => (
                  <li key={i} className="break">
                    <span className="mono">{d.name}</span>
                    {d.line ? `, línea ${d.line}` : ''}: {d.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  )
}

const W = 720
const H = 260
const PAD = { top: 12, right: 16, bottom: 28, left: 52 }

function label(start: number, bucket: number): string {
  const iso = new Date(start * 1000).toISOString()
  return bucket < 86_400 ? `${iso.slice(5, 10)} ${iso.slice(11, 16)}` : iso.slice(0, 10)
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(1)
}

/** Ticks at round steps covering [min, max]. */
function ticks(min: number, max: number, count = 4): number[] {
  if (min === max) return [min]
  const raw = (max - min) / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = ([1, 2, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag
  const out: number[] = []
  for (let t = Math.ceil(min / step) * step; t <= max + step * 1e-9; t += step) out.push(Number(t.toPrecision(12)))
  return out
}

/** One series: mean as a line, minimum–maximum as a band, crosshair and tooltip on hover. */
function SeriesChart({ series, bucket, title, unit }: { series: Bucket[]; bucket: number; title: string; unit: string }) {
  const [hover, setHover] = useState<number | null>(null)
  const first = series[0]!.start
  const last = series[series.length - 1]!.start
  const lo = Math.min(...series.map((b) => b.min))
  const hi = Math.max(...series.map((b) => b.max))
  const pad = hi > lo ? (hi - lo) * 0.05 : Math.abs(hi) * 0.1 || 1
  const y0 = lo - pad
  const y1 = hi + pad
  const x = (t: number) => PAD.left + (last > first ? ((t - first) / (last - first)) * (W - PAD.left - PAD.right) : (W - PAD.left - PAD.right) / 2)
  const y = (v: number) => PAD.top + (1 - (v - y0) / (y1 - y0)) * (H - PAD.top - PAD.bottom)
  const line = series.map((b, i) => `${i ? 'L' : 'M'}${x(b.start).toFixed(1)},${y(b.mean).toFixed(1)}`).join('')
  const band =
    series.map((b, i) => `${i ? 'L' : 'M'}${x(b.start).toFixed(1)},${y(b.max).toFixed(1)}`).join('') +
    [...series].reverse().map((b) => `L${x(b.start).toFixed(1)},${y(b.min).toFixed(1)}`).join('') +
    'Z'
  const xLabels = [...new Set([0, Math.floor((series.length - 1) / 2), series.length - 1])]

  const move = (e: MouseEvent<SVGRectElement>) => {
    const box = e.currentTarget.ownerSVGElement!.getBoundingClientRect()
    const px = ((e.clientX - box.left) / box.width) * W
    let best = 0
    for (let i = 1; i < series.length; i++) if (Math.abs(x(series[i]!.start) - px) < Math.abs(x(series[best]!.start) - px)) best = i
    setHover(best)
  }
  const picked = hover === null ? null : series[hover]!

  return (
    <figure className="chart">
      <figcaption>{title}</figcaption>
      <div className="chart-plot">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Serie de ${title}`}>
          {ticks(lo, hi).map((t) => (
            <g key={t}>
              <line className="grid" x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} />
              <text className="axis" x={PAD.left - 6} y={y(t)} textAnchor="end" dominantBaseline="middle">
                {fmt(t)}
              </text>
            </g>
          ))}
          {xLabels.map((i) => (
            <text key={i} className="axis" x={x(series[i]!.start)} y={H - 8} textAnchor={i === 0 ? 'start' : i === series.length - 1 ? 'end' : 'middle'}>
              {label(series[i]!.start, bucket)}
            </text>
          ))}
          <path className="band" d={band} />
          <path className="mean" d={line} />
          {series.length <= 62 && series.map((b) => <circle key={b.start} className="point" cx={x(b.start)} cy={y(b.mean)} r={4} />)}
          {picked && (
            <>
              <line className="crosshair" x1={x(picked.start)} x2={x(picked.start)} y1={PAD.top} y2={H - PAD.bottom} />
              <circle className="point active" cx={x(picked.start)} cy={y(picked.mean)} r={5} />
            </>
          )}
          <rect x={PAD.left} y={0} width={W - PAD.left - PAD.right} height={H} fill="transparent" onMouseMove={move} onMouseLeave={() => setHover(null)} />
        </svg>
        {picked && (
          <div className="chart-tip" style={{ left: `${(x(picked.start) / W) * 100}%` }}>
            <strong>{label(picked.start, bucket)}</strong>
            <span>
              Promedio {fmt(picked.mean)} {unit}
            </span>
            <span className="muted">
              Mín. {fmt(picked.min)} · máx. {fmt(picked.max)} · {picked.count} {picked.count === 1 ? 'lectura' : 'lecturas'}
            </span>
          </div>
        )}
      </div>
    </figure>
  )
}

function SeriesTable({ series, bucket, unit }: { series: Bucket[]; bucket: number; unit: string }) {
  return (
    <details>
      <summary>Ver como tabla</summary>
      <table className="relays">
        <thead>
          <tr>
            <th>{bucket < 86_400 ? 'Hora (UTC)' : 'Día (UTC)'}</th>
            <th>Promedio {unit}</th>
            <th>Mín.</th>
            <th>Máx.</th>
            <th>Lecturas</th>
          </tr>
        </thead>
        <tbody>
          {series.map((b) => (
            <tr key={b.start}>
              <td>{label(b.start, bucket)}</td>
              <td>{fmt(b.mean)}</td>
              <td>{fmt(b.min)}</td>
              <td>{fmt(b.max)}</td>
              <td>{b.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  )
}
