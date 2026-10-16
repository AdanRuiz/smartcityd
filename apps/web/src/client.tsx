import { Client, workerVerifier, type City, type RelayStatus, type Signer } from '@smartcity/sdk'
import VerifyWorker from '@smartcity/sdk/verify-worker?worker&inline'
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { CITIES, type CityConfig } from './config'
import type { IdentityKind } from './identity'
import { loadSettings, saveSettings, type Settings } from './settings'

export interface Identity {
  kind: IdentityKind
  pubkey: string
}

interface AppState {
  sc: Client
  settings: Settings
  cityConfig: CityConfig
  city: City | null
  identity: Identity | null
  updateSettings(change: Partial<Settings>): void
  setIdentity(signer: Signer | null, kind?: IdentityKind): Promise<void>
}

const Context = createContext<AppState | null>(null)

function createAppClient(settings: Settings, cityConfig: CityConfig): Client {
  let verifier
  try {
    verifier = workerVerifier(new VerifyWorker()) // SDK-5
  } catch {
    verifier = undefined // workers blocked: verify on the main thread
  }
  return new Client({ city: cityConfig.id, relays: settings.relays, trustAnchors: cityConfig.roots, verifier })
}

export function ClientProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState(loadSettings)
  const cityConfig = CITIES.find((c) => c.id === settings.city) ?? CITIES[0]!
  const [sc] = useState(() => createAppClient(settings, cityConfig))
  const [city, setCity] = useState<City | null>(null)
  const [identity, setIdentityState] = useState<Identity | null>(null)

  useEffect(() => {
    let alive = true
    const resolve = () => void sc.resolveCity().then((c) => alive && setCity(c), () => {})
    resolve()
    const timer = setInterval(resolve, 10 * 60_000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [sc])

  const updateSettings = (change: Partial<Settings>) => {
    const next = { ...settings, ...change }
    for (const url of settings.relays) if (!next.relays.includes(url)) sc.relays.remove(url)
    for (const url of next.relays) sc.relays.add(url)
    setSettings(next)
    saveSettings(next)
  }

  const setIdentity = async (signer: Signer | null, kind: IdentityKind = 'local') => {
    if (!signer) {
      sc.setSigner(undefined)
      setIdentityState(null)
      return
    }
    const pubkey = await signer.getPublicKey()
    sc.setSigner(signer)
    setIdentityState({ kind, pubkey })
  }

  return (
    <Context.Provider value={{ sc, settings, cityConfig, city, identity, updateSettings, setIdentity }}>
      {children}
    </Context.Provider>
  )
}

export function useApp(): AppState {
  const state = useContext(Context)
  if (!state) throw new Error('useApp outside ClientProvider')
  return state
}

/** SDK-10: relay status, updated live. */
export function useRelayStatus(): RelayStatus[] {
  const { sc } = useApp()
  const [status, setStatus] = useState(() => sc.relays.status())
  useEffect(() => sc.relays.onChange(setStatus), [sc])
  return status
}
