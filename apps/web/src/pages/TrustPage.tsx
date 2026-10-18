import type { City } from '@smartcity/sdk'
import { decode } from 'nostr-tools/nip19'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useApp } from '../client'
import { Npub, ROLE_LABEL } from '../components'

function parsePubkey(text: string): string | null {
  const t = text.trim()
  if (/^[0-9a-f]{64}$/.test(t)) return t
  try {
    if (!t.startsWith('npub1')) return null
    return decode(t as `npub1${string}`).data
  } catch {
    return null
  }
}

/**
 * Whom this app believes about the city (docs/spec/04): the anchors (TRUST-1, TRUST-2), the definitions of the
 * city to choose from when there are none (TRUST-3), and the keys the anchors gave a role.
 */
export function TrustPage() {
  const { sc, cityConfig, city, anchors, settings, setAnchors, trustVersion } = useApp()
  const [candidates, setCandidates] = useState<City[] | null>(null)
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const attested = useMemo(() => sc.trust.attested(), [sc, trustVersion])

  useEffect(() => {
    let alive = true
    sc.cityCandidates().then(
      (list) => alive && setCandidates(list),
      () => alive && setCandidates([]),
    )
    return () => {
      alive = false
    }
  }, [sc])

  const add = (e: FormEvent) => {
    e.preventDefault()
    const pk = parsePubkey(input)
    if (!pk) return setError('Escribe una llave pública npub1… o hex de 64 caracteres.')
    setError(null)
    setInput('')
    if (!anchors.includes(pk)) void setAnchors([...anchors, pk])
  }

  // TRUST-3: choosing a definition trusts whoever signs it and the roots it names.
  const choose = (c: City) => void setAnchors([...new Set([c.event.pubkey, ...c.content.roots])])

  return (
    <div className="page">
      <h1>Confianza</h1>
      <p className="muted">
        Cualquiera puede publicar. La app decide qué marcar como verificado según las llaves en las que confías (anclas):
        ellas definen la ciudad y dicen quién es autoridad, operador, fuente o moderador.
      </p>

      <h2>Anclas de {cityConfig.name}</h2>
      {anchors.length === 0 ? (
        <p className="notice">
          Esta app no trae llaves raíz para {cityConfig.name} todavía. Sin anclas todo se muestra como «Comunidad» y nadie
          fija el estado oficial de los reportes. Elige una definición de la ciudad abajo o añade una llave que hayas
          comprobado por otro medio.
        </p>
      ) : (
        <ul className="plain">
          {anchors.map((pk) => (
            <li key={pk} className="row-between">
              <Npub pubkey={pk} full />
              <button type="button" onClick={() => void setAnchors(anchors.filter((a) => a !== pk))}>
                Quitar
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} className="row">
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="npub1…" aria-label="Llave pública" />
        <button type="submit">Añadir ancla</button>
        {settings.anchors[cityConfig.id] !== undefined && (
          <button type="button" onClick={() => void setAnchors(null)}>
            {cityConfig.roots.length > 0 ? `Volver a las raíces de la app (${cityConfig.roots.length})` : 'Quitar mis anclas'}
          </button>
        )}
      </form>
      {error && <p className="error">{error}</p>}
      <p className="muted small">
        Las anclas valen solo para {cityConfig.name} (<span className="mono">{cityConfig.id}</span>): cada ciudad tiene las suyas.
      </p>
      <p className="muted small">Compara las llaves con las que publique la ciudad por un canal oficial antes de confiar en ellas.</p>

      <h2>Definiciones de la ciudad</h2>
      {city && (
        <p className="muted">
          En uso: «{city.content.name}», firmada por <Npub pubkey={city.event.pubkey} />.
        </p>
      )}
      {candidates === null && <p className="muted">Buscando…</p>}
      {candidates?.length === 0 && <p className="muted">Ningún relay tiene una definición de «{cityConfig.id}».</p>}
      <ul className="plain">
        {candidates?.map((c) => (
          <li key={c.event.id} className="card">
            <div className="row-between">
              <strong>{c.content.name}</strong>
              <span className="muted small">{new Date(c.event.created_at * 1000).toLocaleDateString()}</span>
            </div>
            <div className="small">
              Firma <Npub pubkey={c.event.pubkey} full />
            </div>
            <div className="small muted">
              Raíces:{' '}
              {c.content.roots.map((r, i) => (
                <span key={r}>
                  {i > 0 && ', '}
                  <Npub pubkey={r} />
                </span>
              ))}
            </div>
            <div className="small muted">Relays: {c.content.relays.join(', ')}</div>
            {anchors.includes(c.event.pubkey) ? (
              <span className="badge verified">Confías en ella</span>
            ) : (
              <button type="button" onClick={() => choose(c)}>
                Confiar en esta definición
              </button>
            )}
          </li>
        ))}
      </ul>

      <h2>Llaves con rol</h2>
      {attested.length === 0 ? (
        <p className="muted">Tus anclas no han publicado una lista de roles para esta ciudad.</p>
      ) : (
        <table>
          <tbody>
            {attested.map(({ pubkey, roles }) => (
              <tr key={pubkey}>
                <td>
                  <Npub pubkey={pubkey} />
                </td>
                <td>{roles.map((r) => ROLE_LABEL[r] ?? r).join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
