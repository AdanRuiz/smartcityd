import { useEffect, useState } from 'react'
import { SINGLE_FILE, loadSelfCopy, selfCopyUrl, type SelfCopy } from '../about'

type Copy = { state: 'loading' } | { state: 'ok'; copy: SelfCopy } | { state: 'error'; message: string } | { state: 'local' }

const singleFile = () => document.querySelector('meta[name="smartcity-variant"]')?.getAttribute('content') === 'single-file'

/**
 * APP-10: version, commit and hash of this build, and a button that saves `smartcity.html` (APP-4). The hash is the
 * sha256 of that file, the one a signed `release` announces (DIST-2), so the user can compare both (APP-9).
 */
export function AboutPage() {
  const [copy, setCopy] = useState<Copy>({ state: 'loading' })
  const single = singleFile()

  useEffect(() => {
    const url = selfCopyUrl(location.href, single)
    if (!url) return setCopy({ state: 'local' })
    let live = true
    loadSelfCopy(url).then(
      (c) => live && setCopy({ state: 'ok', copy: c }),
      (error: unknown) => live && setCopy({ state: 'error', message: error instanceof Error ? error.message : String(error) }),
    )
    return () => {
      live = false
    }
  }, [single])

  return (
    <div className="page">
      <h1>Acerca de</h1>
      <p className="muted">
        SmartCity es una app estática: no tiene servidor propio y cualquier copia funciona igual que esta. Los datos están
        en los relays y en los snapshots, no en la app.
      </p>
      <table className="relays">
        <tbody>
          <tr>
            <th>Versión</th>
            <td>{__APP_VERSION__}</td>
          </tr>
          <tr>
            <th>Commit</th>
            <td className="mono">{__APP_COMMIT__ || 'desconocido'}</td>
          </tr>
          <tr>
            <th>Variante</th>
            <td>{single ? `archivo único (${SINGLE_FILE})` : 'multiarchivo (dist/)'}</td>
          </tr>
          <tr>
            <th>Hash del build</th>
            <td>
              {copy.state === 'ok' && (
                <>
                  <span className="mono">sha256 {copy.copy.sha256}</span>
                  <div className="muted small">
                    de {SINGLE_FILE}, {copy.copy.size.toLocaleString('es')} bytes
                  </div>
                </>
              )}
              {copy.state === 'loading' && 'calculando…'}
              {copy.state === 'error' && <span className="error">No se pudo leer {SINGLE_FILE}: {copy.message}</span>}
              {copy.state === 'local' && (
                <span className="muted">
                  Abierta desde un archivo: el navegador no deja que la página lo lea. Calcúlalo con{' '}
                  <span className="mono">sha256sum {SINGLE_FILE}</span>.
                </span>
              )}
            </td>
          </tr>
        </tbody>
      </table>
      {copy.state !== 'local' && (
        <p className="row">
          <button type="button" disabled={copy.state !== 'ok'} onClick={() => copy.state === 'ok' && save(copy.copy)}>
            Guardar copia de esta app
          </button>
        </p>
      )}
      <p className="muted small">
        {copy.state === 'local'
          ? 'Esta ya es una copia local: guárdala o compártela tal cual.'
          : `Descarga ${SINGLE_FILE}, la app entera en un solo archivo que se abre con doble clic, sin conexión al espejo.`}{' '}
        Antes de abrir una copia que te pasaron, compara su sha256 con el del evento release firmado por los
        desarrolladores: la app nunca se actualiza sola.
      </p>
    </div>
  )
}

function save(copy: SelfCopy) {
  const url = URL.createObjectURL(new Blob([copy.bytes], { type: 'text/html' }))
  const a = document.createElement('a')
  a.href = url
  a.download = SINGLE_FILE
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
