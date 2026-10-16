import { hasNip07 } from '@smartcity/sdk'
import { npubEncode } from 'nostr-tools/nip19'
import { useState, type FormEvent } from 'react'
import { useApp } from '../client'
import { createLocalKey, extensionSigner, forgetLocalKey, importLocalKey, storedKey, unlockLocalKey } from '../identity'

/** ID-1, ID-2, ID-3, ID-6. Reading needs no key; a key is only for publishing. */
export function IdentityPage() {
  const { sc, identity, setIdentity } = useApp()
  const [storageKept, setStorageKept] = useState<boolean | null>(sc.storage.persisted)
  const [saved, setSaved] = useState(storedKey)
  const [pass, setPass] = useState('')
  const [pass2, setPass2] = useState('')
  const [importText, setImportText] = useState('')
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null)
  const [exported, setExported] = useState(false)

  const fail = (text: string) => setMessage({ error: true, text })
  const done = (text: string) => {
    setMessage({ error: false, text })
    setPass('')
    setPass2('')
  }

  const create = async (e: FormEvent) => {
    e.preventDefault()
    if (pass.length < 8) return fail('La frase debe tener al menos 8 caracteres.')
    if (pass !== pass2) return fail('Las frases no coinciden.')
    const { signer, ncryptsec, persisted } = createLocalKey(pass)
    await setIdentity(signer, 'local')
    setSaved(persisted ? ncryptsec : null)
    setExported(false)
    // ID-7, SDK-11: ask the browser not to clear this origin's data on its own.
    setStorageKept(await sc.storage.persist())
    if (persisted) done('Llave creada y guardada cifrada en este navegador.')
    else {
      done('Llave creada, pero este navegador no permite guardarla: se descargó la copia cifrada.')
      download(ncryptsec)
    }
  }

  const unlock = async (e: FormEvent) => {
    e.preventDefault()
    try {
      await setIdentity(unlockLocalKey(pass), 'local')
      done('Llave desbloqueada.')
    } catch {
      fail('Frase incorrecta.')
    }
  }

  const importKey = async (e: FormEvent) => {
    e.preventDefault()
    try {
      await setIdentity(importLocalKey(importText, pass), 'local')
      setSaved(storedKey())
      setImportText('')
      done('Llave importada.')
    } catch {
      fail('No se pudo abrir: revisa el texto ncryptsec1… y la frase.')
    }
  }

  const connectExtension = async () => {
    try {
      await setIdentity(extensionSigner(), 'nip07')
      done('Firmando con la extensión del navegador.')
    } catch (error) {
      fail(`La extensión no respondió: ${String(error)}`)
    }
  }

  const exportKey = (how: 'file' | 'clipboard') => {
    if (!saved) return
    if (how === 'file') {
      download(saved)
      setExported(true)
    } else void navigator.clipboard?.writeText(saved).then(() => setExported(true))
  }

  return (
    <div className="page narrow">
      <h1>Identidad</h1>
      <p className="muted">
        Para ver datos no hace falta llave. La llave solo sirve para publicar: no hay cuenta, correo ni contraseña que
        recuperar.
      </p>

      {identity && (
        <div className="card">
          <div>{identity.kind === 'nip07' ? 'Extensión del navegador' : 'Llave de este dispositivo'} · activa</div>
          <div className="mono small break">{npubEncode(identity.pubkey)}</div>
          <button type="button" onClick={() => void setIdentity(null).then(() => done('Modo solo lectura.'))}>
            Bloquear (solo lectura)
          </button>
        </div>
      )}

      {saved && (
        <section className="card warn">
          <h2>Copia de seguridad</h2>
          <p>
            Si pierdes esta llave no hay forma de recuperarla, y el navegador puede borrar sus datos sin avisar. Guarda la
            copia cifrada fuera del navegador; para abrirla hará falta tu frase.
          </p>
          <div className="row">
            <button type="button" onClick={() => exportKey('file')}>
              Descargar llave cifrada
            </button>
            <button type="button" onClick={() => exportKey('clipboard')}>
              Copiar
            </button>
          </div>
          {storageKept === false && !exported && (
            <p className="error">
              El navegador no garantizó guardar los datos de esta app: puede borrarlos sin avisar. Exporta la llave ahora.
            </p>
          )}
          {exported && <p className="muted small">Copia exportada (ncryptsec, NIP-49).</p>}
        </section>
      )}

      {!identity && saved && (
        <form onSubmit={unlock} className="card">
          <h2>Desbloquear la llave guardada</h2>
          <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="Frase" autoComplete="current-password" />
          <div className="row">
            <button type="submit">Desbloquear</button>
            <button
              type="button"
              className="danger"
              onClick={() => {
                if (confirm('¿Borrar la llave de este navegador? Sin una copia, se pierde para siempre.')) {
                  forgetLocalKey()
                  setSaved(null)
                }
              }}
            >
              Borrar de este navegador
            </button>
          </div>
        </form>
      )}

      {!identity && (
        <>
          {hasNip07() && (
            <div className="card">
              <h2>Extensión del navegador (NIP-07)</h2>
              <p className="muted">La llave se queda en la extensión; la app solo le pide firmas.</p>
              <button type="button" onClick={() => void connectExtension()}>
                Usar extensión
              </button>
            </div>
          )}
          {!saved && (
            <form onSubmit={create} className="card">
              <h2>Crear una llave en este dispositivo</h2>
              <p className="muted">Se guarda cifrada con tu frase (NIP-49), nunca en claro.</p>
              <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="Frase (8+ caracteres)" autoComplete="new-password" />
              <input type="password" value={pass2} onChange={(e) => setPass2(e.target.value)} placeholder="Repite la frase" autoComplete="new-password" />
              <button type="submit">Crear llave</button>
            </form>
          )}
          <form onSubmit={importKey} className="card">
            <h2>Importar una llave cifrada</h2>
            <textarea value={importText} onChange={(e) => setImportText(e.target.value)} placeholder="ncryptsec1…" rows={3} />
            <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="Frase" autoComplete="current-password" />
            <button type="submit">Importar</button>
          </form>
        </>
      )}

      {message && <p className={message.error ? 'error' : 'ok'}>{message.text}</p>}
    </div>
  )
}

function download(ncryptsec: string) {
  const url = URL.createObjectURL(new Blob([`${ncryptsec}\n`], { type: 'text/plain' }))
  const a = document.createElement('a')
  a.href = url
  a.download = 'smartcity-llave.ncryptsec.txt'
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
