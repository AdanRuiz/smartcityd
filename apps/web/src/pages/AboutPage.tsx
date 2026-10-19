import { useEffect, useRef, useState } from 'react'
import { isSameBuild, loadSelfCopy, selfCopyUrl, type SelfCopy } from '../about'
import { SINGLE_FILE, isSingleFile, runningBuildId } from '../variant'

type Copy =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ok'; copy: SelfCopy }
  | { state: 'stale' }
  | { state: 'error'; message: string }

/**
 * APP-10: version, commit and hash of this build, and a button that saves `smartcity.html` (APP-4). The hash is the
 * sha256 of that file, the one a signed `release` announces (DIST-2). It is downloaded only when asked: about 2 MB.
 * A page cannot vouch for itself (a tampered copy can show any hash), so it says that the check that counts is
 * `sha256sum` on the saved file against the `release` (APP-9).
 */
export function AboutPage() {
  const [copy, setCopy] = useState<Copy>({ state: 'idle' })
  const single = isSingleFile()
  const url = selfCopyUrl(location.href, single)
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

  const load = (target: string) => {
    setCopy({ state: 'loading' })
    loadSelfCopy(target).then(
      (c) => live.current && setCopy(isSameBuild(c, runningBuildId()) ? { state: 'ok', copy: c } : { state: 'stale' }),
      (error: unknown) => live.current && setCopy({ state: 'error', message: error instanceof Error ? error.message : String(error) }),
    )
  }

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
            <td>
              <span className="mono">{__APP_COMMIT__ || 'desconocido'}</span>
              {__APP_DIRTY__ && <div className="muted small">con cambios sin commitear: el commit no describe este código</div>}
            </td>
          </tr>
          <tr>
            <th>Variante</th>
            <td>{single ? `archivo único (${SINGLE_FILE})` : 'multiarchivo (dist/)'}</td>
          </tr>
          <tr>
            <th>Hash del build</th>
            <td>
              {!url && (
                <span className="muted">
                  Abierta desde un archivo: el navegador no deja que la página lo lea. Calcúlalo con{' '}
                  <span className="mono">sha256sum {SINGLE_FILE}</span>.
                </span>
              )}
              {url && copy.state === 'idle' && (
                <button type="button" onClick={() => load(url)}>
                  Calcular (descarga {SINGLE_FILE}, unos 2 MB)
                </button>
              )}
              {copy.state === 'loading' && 'calculando…'}
              {copy.state === 'ok' && (
                <>
                  <span className="mono">sha256 {copy.copy.sha256}</span>
                  <div className="muted small">
                    de {SINGLE_FILE} tal como lo sirve este sitio, {copy.copy.size.toLocaleString('es')} bytes
                  </div>
                </>
              )}
              {copy.state === 'stale' && (
                <span className="error">
                  Este sitio ya sirve otra versión que la que tienes abierta. Recarga la página para ver la versión y el hash
                  de la nueva.
                </span>
              )}
              {copy.state === 'error' && <span className="error">No se pudo leer {SINGLE_FILE}: {copy.message}</span>}
            </td>
          </tr>
        </tbody>
      </table>
      {url && (
        <p className="row">
          <button type="button" disabled={copy.state !== 'ok'} onClick={() => copy.state === 'ok' && save(copy.copy)}>
            Guardar copia de esta app
          </button>
        </p>
      )}
      <p className="muted small">
        {url
          ? `Descarga ${SINGLE_FILE}, la app entera en un solo archivo que se abre con doble clic, sin conexión al espejo.`
          : single
            ? 'Esta ya es una copia local: guárdala o compártela tal cual.'
            : `Esta carpeta solo funciona completa: para compartir la app en un archivo, usa ${SINGLE_FILE}, que está junto a index.html.`}{' '}
        La página calcula este hash con lo que le sirve el sitio y no puede garantizarse a sí misma: una copia alterada
        mostraría cualquier hash. La comprobación que vale es pasar <span className="mono">sha256sum</span> al archivo
        descargado y compararlo con el del evento release firmado por los desarrolladores. La app nunca se actualiza sola.
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
