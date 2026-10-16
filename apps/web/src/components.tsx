import { TRUST_LEVELS, type TrustLevel } from '@smartcity/sdk'
import { npubEncode } from 'nostr-tools/nip19'
import { openLocalTiles } from './useMap'

export const TRUST_LABEL: Record<TrustLevel, string> = {
  verified: 'Verificado',
  community: 'Comunidad',
  flagged: 'Señalado',
}

export const ROLE_LABEL: Record<string, string> = {
  authority: 'autoridad',
  operator: 'operador',
  source: 'fuente',
  app: 'app',
  archiver: 'archivista',
  moderator: 'moderador',
  blocked: 'bloqueada',
}

/** Default view of docs/spec/04: `flagged` hidden until the user asks for it. */
export const DEFAULT_LEVELS: TrustLevel[] = ['verified', 'community']

/** TRUST-5: which levels a layer shows. */
export function TrustFilter({ value, onChange }: { value: TrustLevel[]; onChange(levels: TrustLevel[]): void }) {
  return (
    <fieldset className="levels">
      <legend>Confianza</legend>
      {TRUST_LEVELS.map((level) => (
        <label key={level} className="check">
          <input
            type="checkbox"
            checked={value.includes(level)}
            onChange={(e) => onChange(e.target.checked ? [...value, level] : value.filter((l) => l !== level))}
          />
          <TrustBadge level={level} />
        </label>
      ))}
    </fieldset>
  )
}

export function TrustBadge({ level }: { level: TrustLevel }) {
  return <span className={`badge ${level}`}>{TRUST_LABEL[level]}</span>
}

/** A pubkey as `npub…`, shortened, with the full value on hover (TRUST-8: comparable fingerprints). */
export function Npub({ pubkey, full = false }: { pubkey: string; full?: boolean }) {
  const npub = npubEncode(pubkey)
  return (
    <span className="mono" title={npub}>
      {full ? npub : `${npub.slice(0, 12)}…${npub.slice(-6)}`}
    </span>
  )
}

/** Without a basemap: open a `.pmtiles` from disk, which works with no network (copy distributed by torrent). */
export function BasemapPicker() {
  return (
    <label className="file">
      Sin mapa base. <span className="link">Abrir archivo .pmtiles</span>
      <input
        type="file"
        accept=".pmtiles"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) openLocalTiles(file)
        }}
      />
    </label>
  )
}

export function timeAgo(seconds: number): string {
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - seconds)
  if (diff < 60) return 'hace un momento'
  if (diff < 3600) return `hace ${Math.floor(diff / 60)} min`
  if (diff < 86_400) return `hace ${Math.floor(diff / 3600)} h`
  return new Date(seconds * 1000).toLocaleDateString()
}
