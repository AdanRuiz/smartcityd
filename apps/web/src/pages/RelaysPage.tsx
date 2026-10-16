import { normalizeUrl } from '@smartcity/sdk'
import { useEffect, useState, type FormEvent } from 'react'
import { useApp, useRelayStatus } from '../client'
import { SEED_RELAYS } from '../config'

const STATE_LABEL = { idle: 'sin usar', connecting: 'conectando', open: 'conectado', closed: 'desconectado' } as const

/** SDK-10, REPL-5: relay panel. The user edits the seed list; the city's relays come from its definition. */
export function RelaysPage() {
  const { sc, settings, updateSettings, city } = useApp()
  const status = useRelayStatus()
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const fromCity = new Set((city?.content.relays ?? []).flatMap((u) => safeNormalize(u) ?? []))

  // Connections open on first use; here, open them all to show their state.
  useEffect(() => void sc.relays.connect(), [sc, settings.relays])

  const add = (e: FormEvent) => {
    e.preventDefault()
    const url = safeNormalize(input)
    if (!url || !url.startsWith('wss://')) return setError('Escribe una URL wss:// válida.')
    setError(null)
    setInput('')
    if (!settings.relays.includes(url)) updateSettings({ relays: [...settings.relays, url] })
  }

  return (
    <div className="page">
      <h1>Relays</h1>
      <p className="muted">
        La app publica en todos y lee de todos, y une lo que recibe. Ninguno es obligatorio: si uno cae, siguen los
        demás.
      </p>
      <table className="relays">
        <thead>
          <tr>
            <th>Relay</th>
            <th>Estado</th>
            <th>Latencia</th>
            <th>Origen</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {status.map((r) => (
            <tr key={r.url}>
              <td className="mono">{r.url}</td>
              <td>
                <span className={`dot ${r.state}`} /> {STATE_LABEL[r.state]}
                {r.lastError && r.state !== 'open' && <div className="muted small">{r.lastError}</div>}
              </td>
              <td>{r.latencyMs === null ? '—' : `${r.latencyMs} ms`}</td>
              <td>{settings.relays.includes(r.url) ? 'lista propia' : fromCity.has(r.url) ? 'ciudad' : '—'}</td>
              <td>
                {settings.relays.includes(r.url) && (
                  <button type="button" onClick={() => updateSettings({ relays: settings.relays.filter((u) => u !== r.url) })}>
                    Quitar
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form onSubmit={add} className="row">
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="wss://relay.ejemplo.org" aria-label="URL del relay" />
        <button type="submit">Añadir</button>
        <button type="button" onClick={() => updateSettings({ relays: [...SEED_RELAYS] })}>
          Restaurar lista semilla
        </button>
      </form>
      {error && <p className="error">{error}</p>}
    </div>
  )
}

function safeNormalize(url: string): string | null {
  try {
    return normalizeUrl(url)
  } catch {
    return null
  }
}
