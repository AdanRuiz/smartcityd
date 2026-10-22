import { PowCancelled, REPORT_PRECISION, type LatLon, type Report, type ReportStatus, type TrustLevel } from '@smartcity/sdk'
import { REPORT_CATEGORIES, type Attachment } from '@smartcity/schemas'
import type { GeoJSONSource, Map as MapLibreMap, MapLayerMouseEvent, MapMouseEvent } from 'maplibre-gl'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { useApp } from '../client'
import { BasemapPicker, DEFAULT_LEVELS, Npub, ROLE_LABEL, TrustBadge, TrustFilter, timeAgo } from '../components'
import { readItem, writeItem } from '../settings'
import { useCityMap, useTiles } from '../useMap'

const REPORTS = 'reports'
const DRAFT = 'draft'
const NOTICE_KEY = 'sc.publicNotice'
const WINDOW_S = 90 * 86_400

export const STATUS_LABEL: Record<ReportStatus, string> = {
  open: 'Abierto',
  ack: 'Recibido',
  in_progress: 'En proceso',
  resolved: 'Resuelto',
  rejected: 'Rechazado',
  duplicate: 'Duplicado',
}
const STATUS_COLOR: Record<ReportStatus, string> = {
  open: '#e76f51',
  ack: '#e9c46a',
  in_progress: '#f4a261',
  resolved: '#2a9d8f',
  rejected: '#6b7280',
  duplicate: '#6b7280',
}
const CATEGORY_LABEL: Record<string, string> = {
  bache: 'Bache',
  alumbrado: 'Alumbrado',
  fuga: 'Fuga',
  basura: 'Basura',
  semaforo: 'Semáforo',
  arbolado: 'Arbolado',
  otro: 'Otro',
}
const OPEN: ReportStatus[] = ['open', 'ack', 'in_progress']

type StatusView = 'all' | 'open' | 'closed'

function addLayers(map: MapLibreMap) {
  if (map.getSource(REPORTS)) return
  const empty = { type: 'FeatureCollection' as const, features: [] }
  map.addSource(REPORTS, { type: 'geojson', data: empty })
  map.addSource(DRAFT, { type: 'geojson', data: empty })
  map.addLayer({
    id: REPORTS,
    type: 'circle',
    source: REPORTS,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 5, 15, 10],
      'circle-color': ['get', 'color'],
      'circle-stroke-width': ['case', ['get', 'selected'], 4, ['get', 'verified'], 3, 1.5],
      'circle-stroke-color': ['case', ['get', 'selected'], '#facc15', ['get', 'verified'], '#1d4ed8', '#ffffff'],
    },
  })
  map.addLayer({
    id: DRAFT,
    type: 'circle',
    source: DRAFT,
    paint: { 'circle-radius': 9, 'circle-color': '#ffffff', 'circle-stroke-width': 3, 'circle-stroke-color': '#e76f51' },
  })
}

type Feature = { type: 'Feature'; geometry: { type: 'Point'; coordinates: [number, number] }; properties: Record<string, unknown> }
type FeatureCollection = { type: 'FeatureCollection'; features: Feature[] }

const collection = (features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features })
const point = (loc: LatLon, properties: Record<string, unknown> = {}): Feature => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [loc[1], loc[0]] },
  properties,
})

/** Reports of the city: map, list, detail with history, and creation (docs/spec/03, PRIV-3, PRIV-5, PRIV-6). */
export function ReportsPage() {
  const { sc, trustVersion } = useApp()
  const container = useRef<HTMLDivElement>(null)
  const tiles = useTiles()
  const { map, ready } = useCityMap(container, tiles, addLayers)
  const [reports, setReports] = useState<Report[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState<LatLon | null>(null)
  const [levels, setLevels] = useState<TrustLevel[]>(DEFAULT_LEVELS)
  const [category, setCategory] = useState('')
  const [statusView, setStatusView] = useState<StatusView>('open')
  const [reload, setReload] = useState(0)

  // Stored and new reports of the city, again on every change and every trust change (TRUST-7).
  useEffect(() => {
    let alive = true
    sc.reports.query({ since: Math.floor(Date.now() / 1000) - WINDOW_S, limit: 500 }).then(
      (list) => alive && setReports(list),
      () => alive && setReports([]),
    )
    return () => {
      alive = false
    }
  }, [sc, reload, trustVersion])
  useEffect(() => sc.reports.watch(() => setReload((n) => n + 1)), [sc])

  const visible = useMemo(
    () =>
      (reports ?? []).filter(
        (r) =>
          levels.includes(r.trust) &&
          (!category || r.categories.includes(category)) &&
          (statusView === 'all' || (statusView === 'open') === OPEN.includes(r.status)),
      ),
    [reports, levels, category, statusView],
  )
  const selected = reports?.find((r) => r.id === selectedId) ?? null

  // Clicks: on a report, select it; elsewhere while creating, place the new one.
  const creatingRef = useRef(creating)
  creatingRef.current = creating
  useEffect(() => {
    const m = map.current
    if (!m) return
    const onReport = (e: MapLayerMouseEvent) => {
      if (creatingRef.current) return
      setSelectedId((e.features?.[0]?.properties?.id as string | undefined) ?? null)
    }
    const onMap = (e: MapMouseEvent) => {
      if (creatingRef.current) setDraft([e.lngLat.lat, e.lngLat.lng])
    }
    const enter = () => (m.getCanvas().style.cursor = 'pointer')
    const leave = () => (m.getCanvas().style.cursor = '')
    m.on('click', REPORTS, onReport)
    m.on('click', onMap)
    m.on('mouseenter', REPORTS, enter)
    m.on('mouseleave', REPORTS, leave)
    return () => {
      m.off('click', REPORTS, onReport)
      m.off('click', onMap)
      m.off('mouseenter', REPORTS, enter)
      m.off('mouseleave', REPORTS, leave)
    }
  }, [map])

  useEffect(() => {
    const source = map.current?.getSource(REPORTS) as GeoJSONSource | undefined
    if (!ready || !source) return
    source.setData(
      collection(
        visible.map((r) =>
          point(r.loc, { id: r.id, color: STATUS_COLOR[r.status], verified: r.trust === 'verified', selected: r.id === selectedId }),
        ),
      ),
    )
  }, [ready, visible, selectedId])

  useEffect(() => {
    const source = map.current?.getSource(DRAFT) as GeoJSONSource | undefined
    if (!ready || !source) return
    source.setData(collection(creating && draft ? [point(draft)] : []))
  }, [ready, creating, draft])

  const mapCenter = (): LatLon | null => {
    const c = map.current?.getCenter()
    return c ? [c.lat, c.lng] : null
  }

  return (
    <div className="map-page">
      <div ref={container} className={`map${creating ? ' placing' : ''}`} />
      <aside className="panel">
        {creating ? (
          <NewReport
            draft={draft}
            useCenter={() => setDraft(mapCenter())}
            onClose={(createdId) => {
              setCreating(false)
              setDraft(null)
              if (createdId) {
                setSelectedId(createdId)
                setReload((n) => n + 1)
              }
            }}
          />
        ) : selected ? (
          <ReportDetail report={selected} onBack={() => setSelectedId(null)} onChanged={() => setReload((n) => n + 1)} />
        ) : (
          <>
            <button type="button" className="primary" onClick={() => setCreating(true)}>
              Nuevo reporte
            </button>
            <div className="row">
              <label>
                Categoría
                <select value={category} onChange={(e) => setCategory(e.target.value)}>
                  <option value="">Todas</option>
                  {REPORT_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {CATEGORY_LABEL[c] ?? c}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Estado
                <select value={statusView} onChange={(e) => setStatusView(e.target.value as StatusView)}>
                  <option value="open">Abiertos</option>
                  <option value="closed">Cerrados</option>
                  <option value="all">Todos</option>
                </select>
              </label>
            </div>
            <TrustFilter value={levels} onChange={setLevels} />
            {reports === null && <p className="muted">Cargando reportes…</p>}
            {reports !== null && visible.length === 0 && <p className="muted">No hay reportes con estos filtros.</p>}
            <ul className="list">
              {visible.map((r) => (
                <li key={r.id}>
                  <button type="button" className="item" onClick={() => setSelectedId(r.id)}>
                    <span className="row-between">
                      <strong>{r.title}</strong>
                      <StatusChip status={r.status} />
                    </span>
                    <span className="muted small">
                      {r.categories.map((c) => CATEGORY_LABEL[c] ?? c).join(', ')} · {timeAgo(r.created_at)}
                      {r.updates.length > 0 ? ` · ${r.updates.length} ${r.updates.length === 1 ? 'actualización' : 'actualizaciones'}` : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        {!tiles && <BasemapPicker />}
      </aside>
    </div>
  )
}

function StatusChip({ status }: { status: ReportStatus }) {
  return (
    <span className="status" style={{ background: STATUS_COLOR[status] }}>
      {STATUS_LABEL[status]}
    </span>
  )
}

function NewReport({ draft, useCenter, onClose }: { draft: LatLon | null; useCenter(): void; onClose(createdId?: string): void }) {
  const { sc, identity } = useApp()
  const [category, setCategory] = useState<string>(REPORT_CATEGORIES[0])
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [stable, setStable] = useState(false)
  const [noticeSeen, setNoticeSeen] = useState(() => readItem(NOTICE_KEY) === '1')
  const [noticeOk, setNoticeOk] = useState(false)
  const [busy, setBusy] = useState<AbortController | null>(null)
  const [result, setResult] = useState<{ error: boolean; text: string; id?: string } | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!draft) return setResult({ error: true, text: 'Toca el mapa para ubicar el reporte.' })
    if (!noticeSeen && !noticeOk) return setResult({ error: true, text: 'Confirma que leíste el aviso.' })
    if (!noticeSeen) {
      writeItem(NOTICE_KEY, '1') // PRIV-6: shown once
      setNoticeSeen(true)
    }
    const controller = new AbortController()
    setBusy(controller)
    setResult(null)
    try {
      const res = await sc.reports.create({
        category,
        title: title.trim(),
        ...(body.trim() ? { body: body.trim() } : {}),
        loc: draft,
        identity: stable ? 'stable' : 'disposable',
        signal: controller.signal,
      })
      if (res.accepted.length > 0) setResult({ error: false, text: `Publicado en ${res.accepted.length} relay(s).`, id: res.id })
      else if (res.queued) setResult({ error: false, text: 'Sin conexión: quedó guardado y se enviará al reconectar.', id: res.id })
      else setResult({ error: true, text: `Rechazado: ${res.rejected.map((r) => r.reason).join('; ')}` })
    } catch (error) {
      setResult({ error: true, text: error instanceof PowCancelled ? 'Cancelado.' : String((error as Error).message ?? error) })
    } finally {
      setBusy(null)
    }
  }

  if (result?.id) {
    return (
      <div className="card">
        <p>{result.text}</p>
        <button type="button" onClick={() => onClose(result.id)}>
          Ver el reporte
        </button>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="stack">
      <h2>Nuevo reporte</h2>
      <p className="muted small">
        {draft
          ? `Ubicación: ${draft[0].toFixed(REPORT_PRECISION)}, ${draft[1].toFixed(REPORT_PRECISION)}`
          : 'Toca el mapa donde está el problema.'}{' '}
        <button type="button" className="link" onClick={useCenter}>
          Usar el centro del mapa
        </button>
      </p>
      <label>
        Categoría
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          {REPORT_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABEL[c] ?? c}
            </option>
          ))}
        </select>
      </label>
      <label>
        Título
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} required />
      </label>
      <label>
        Descripción (opcional)
        <textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} rows={4} />
      </label>
      <fieldset>
        <legend>Firmar con</legend>
        <label className="check">
          <input type="radio" checked={!stable} onChange={() => setStable(false)} />
          Una llave nueva solo para este reporte (recomendado: nadie puede unir tus reportes)
        </label>
        <label className="check">
          <input type="radio" checked={stable} disabled={!identity} onChange={() => setStable(true)} />
          Mi identidad{identity ? '' : ' (no tienes una)'}
        </label>
      </fieldset>
      <p className="muted small">
        La ubicación se publica redondeada a unos 11 m y será pública. No incluyas nombres, teléfonos ni datos de personas.
      </p>
      {!noticeSeen && (
        <div className="notice">
          <p>
            Lo que publiques es público, queda firmado y se copia a varios relays y archivos. No se puede borrar con
            garantía.
          </p>
          <label className="check">
            <input type="checkbox" checked={noticeOk} onChange={(e) => setNoticeOk(e.target.checked)} />
            Entendido
          </label>
        </div>
      )}
      {result && <p className={result.error ? 'error' : 'muted'}>{result.text}</p>}
      <div className="row">
        {busy ? (
          <>
            <span className="muted">Calculando prueba de trabajo y enviando…</span>
            <button type="button" onClick={() => busy.abort()}>
              Cancelar
            </button>
          </>
        ) : (
          <>
            <button type="submit" className="primary">
              Publicar
            </button>
            <button type="button" onClick={() => onClose()}>
              Volver
            </button>
          </>
        )}
      </div>
    </form>
  )
}

function ReportDetail({ report, onBack, onChanged }: { report: Report; onBack(): void; onChanged(): void }) {
  const { sc, identity, trustVersion } = useApp()
  const [showFlagged, setShowFlagged] = useState(false)
  const [status, setStatus] = useState<ReportStatus | ''>('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null)
  const official = useMemo(
    () => (identity ? sc.trust.hasRole(identity.pubkey, 'authority', 'operator') : false),
    [sc, identity, trustVersion],
  )
  const updates = report.updates.filter((u) => showFlagged || u.trust !== 'flagged')
  const hiddenCount = report.updates.length - updates.length

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!status && !body.trim()) return setMessage({ error: true, text: 'Escribe un comentario o elige un estado.' })
    setBusy(true)
    setMessage(null)
    try {
      const res = await sc.reports.update(report, { ...(status ? { status } : {}), ...(body.trim() ? { body: body.trim() } : {}) })
      setMessage({
        error: res.accepted.length === 0 && !res.queued,
        text: res.accepted.length > 0 ? 'Publicado.' : res.queued ? 'Sin conexión: se enviará al reconectar.' : 'Rechazado.',
      })
      setBody('')
      setStatus('')
      onChanged()
    } catch (error) {
      setMessage({ error: true, text: String((error as Error).message ?? error) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="stack">
      <button type="button" className="link" onClick={onBack}>
        ← Todos los reportes
      </button>
      <div className="row-between">
        <h2>{report.title}</h2>
        <StatusChip status={report.status} />
      </div>
      <div className="muted small">
        {report.categories.map((c) => CATEGORY_LABEL[c] ?? c).join(', ')} · {new Date(report.created_at * 1000).toLocaleString()} ·{' '}
        <TrustBadge level={report.trust} />
      </div>
      {report.body && <p className="pre">{report.body}</p>}
      <Photos attachments={report.attachments} />
      <div className="muted small">
        {report.loc[0]}, {report.loc[1]} · autor <Npub pubkey={report.pubkey} />
      </div>
      <p className="muted small">
        {report.statusUpdate
          ? `Estado oficial fijado por una llave con rol de ${sc.trust.rolesOf(report.statusUpdate.pubkey).map((role) => ROLE_LABEL[role] ?? role).join(', ')} el ${new Date(report.statusUpdate.created_at * 1000).toLocaleString()}.`
          : 'Sin actualización de una autoridad u operador: el estado es "abierto".'}
      </p>
      <h3>Historial</h3>
      {updates.length === 0 && <p className="muted">Sin actualizaciones.</p>}
      <ul className="history">
        {updates.map((u) => (
          <li key={u.id} className={u.official ? 'official' : ''}>
            <div className="row-between small">
              <span>
                {u.official ? <strong>Oficial</strong> : 'Comentario'} · <Npub pubkey={u.pubkey} />
              </span>
              <span className="muted">{timeAgo(u.created_at)}</span>
            </div>
            {u.status && (
              <div className="small">
                {u.official ? 'Estado: ' : 'Propone: '}
                {STATUS_LABEL[u.status]}
              </div>
            )}
            {u.body && <p className="pre">{u.body}</p>}
            <Photos attachments={u.attachments} />
            {u.trust === 'flagged' && <TrustBadge level="flagged" />}
          </li>
        ))}
      </ul>
      {hiddenCount > 0 && (
        <button type="button" className="link" onClick={() => setShowFlagged(true)}>
          Mostrar {hiddenCount} oculta(s) por moderación
        </button>
      )}
      {identity ? (
        <form onSubmit={submit} className="stack">
          {official ? (
            <label>
              Cambiar estado (como autoridad u operador)
              <select value={status} onChange={(e) => setStatus(e.target.value as ReportStatus | '')}>
                <option value="">Sin cambio</option>
                {Object.entries(STATUS_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="muted small">Tu comentario no cambia el estado: eso lo hace una llave con rol de autoridad u operador.</p>
          )}
          <label>
            Comentario
            <textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} rows={3} />
          </label>
          {message && <p className={message.error ? 'error' : 'muted'}>{message.text}</p>}
          <button type="submit" disabled={busy}>
            {busy ? 'Enviando…' : 'Publicar'}
          </button>
        </form>
      ) : (
        <p className="muted small">
          Para comentar necesitas una <Link to="/identidad">identidad</Link>.
        </p>
      )}
    </div>
  )
}

/**
 * SEC-4: each photo is downloaded by the SDK, which keeps it only if its sha256 matches the event's, and shown from
 * a local `blob:` URL; the remote URL is never linked (the CSP has no `https:` in `img-src`).
 */
function Photos({ attachments }: { attachments: Attachment[] }) {
  if (attachments.length === 0) return null
  return (
    <div className="photos">
      {attachments.map((a) => (
        <Photo key={a.x} attachment={a} />
      ))}
    </div>
  )
}

function Photo({ attachment }: { attachment: Attachment }) {
  const { sc } = useApp()
  const [state, setState] = useState<{ url: string } | 'loading' | 'failed'>('loading')
  useEffect(() => {
    let url: string | null = null
    let cancelled = false
    setState('loading')
    sc.attachments
      .read(attachment)
      .then(({ data, mime }) => {
        if (cancelled) return
        url = URL.createObjectURL(new Blob([data.slice()], { type: mime }))
        setState({ url })
      })
      .catch(() => {
        if (!cancelled) setState('failed')
      })
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [sc, attachment])
  if (state === 'loading') return <span className="photo muted small">Verificando foto…</span>
  if (state === 'failed') return <span className="photo muted small">Foto no disponible o alterada</span>
  return <img className="photo" src={state.url} alt="Foto del reporte" />
}
