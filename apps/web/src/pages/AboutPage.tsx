import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { isSameBuild, loadSelfCopy, selfCopyUrl, type SelfCopy } from '../about'
import { applyBackup, BACKUP_FILE, backupText, parseBackup } from '../backup'
import { useApp } from '../client'
import { getPlace } from '../geo/store'
import { storedKey } from '../identity'
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
      <BackupSection />
    </div>
  )
}

/**
 * APP-11: each mirror, IPFS gateway or local file keeps its own data, so a copy opened elsewhere starts empty. The
 * backup file takes settings, chosen city and the encrypted key to it; the import applies on reload.
 */
function BackupSection() {
  const { settings } = useApp()
  const picker = useRef<HTMLInputElement>(null)
  const [message, setMessage] = useState<{ error: boolean; text: string; reload?: boolean } | null>(null)

  const exportFile = () => {
    const text = backupText({ settings, place: getPlace(), ncryptsec: storedKey() })
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = BACKUP_FILE
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const importFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    let result: ReturnType<typeof applyBackup>
    try {
      result = applyBackup(parseBackup(await file.text()))
    } catch (error) {
      return setMessage({ error: true, text: `No se pudo importar: ${error instanceof Error ? error.message : String(error)}.` })
    }
    if (!result.saved) return setMessage({ error: true, text: 'Este navegador no deja que la app guarde datos aquí: no se cambió nada.' })
    const key = {
      none: '',
      imported: ' La llave cifrada quedó guardada: desbloquéala en Identidad con tu frase.',
      same: ' La llave de la copia es la que ya tenías.',
      kept: ' La llave de la copia no se importó porque aquí ya hay otra; bórrala en Identidad (con una copia) si quieres cambiarla.',
    }[result.key]
    setMessage({ error: result.key === 'kept', text: `Ajustes importados; se aplican al recargar.${key}`, reload: true })
  }

  return (
    <section>
      <h2>Llevar tus ajustes a otra copia</h2>
      <p className="muted small">
        Cada espejo, gateway IPFS o archivo abierto en tu equipo guarda sus datos aparte. Para usar tus relays, anclas,
        ciudad elegida y llave en otra copia, descarga tus ajustes aquí y ábrelos allí. La llave va cifrada con tu frase
        (ncryptsec), nunca en claro, y el archivo no sale de tu equipo salvo que tú lo envíes.
      </p>
      <div className="row">
        <button type="button" onClick={exportFile}>
          Descargar ajustes
        </button>
        <button type="button" onClick={() => picker.current?.click()}>
          Importar ajustes
        </button>
        <input ref={picker} type="file" accept="application/json,.json" hidden onChange={(e) => void importFile(e)} />
      </div>
      {message && (
        <p className={message.error ? 'error' : 'ok'}>
          {message.text}{' '}
          {message.reload && (
            <button type="button" onClick={() => location.reload()}>
              Recargar ahora
            </button>
          )}
        </p>
      )}
    </section>
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
