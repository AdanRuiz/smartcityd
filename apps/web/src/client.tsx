import {
  Client,
  indexedDbStore,
  memoryStore,
  workerMiner,
  workerVerifier,
  type City,
  type Miner,
  type OutboxEntry,
  type RelayStatus,
  type Signer,
  type Verifier,
} from '@smartcity/sdk'
import PowWorker from '@smartcity/sdk/pow-worker?worker&inline'
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
  /** Anchors in use: the user's choice or, by default, the roots of the build (TRUST-1, TRUST-2). */
  anchors: string[]
  /** Changes whenever trust levels may have changed (TRUST-7): components recompute with it. */
  trustVersion: number
  updateSettings(change: Partial<Settings>): void
  setAnchors(anchors: string[] | null): Promise<void>
  setIdentity(signer: Signer | null, kind?: IdentityKind): Promise<void>
}

const Context = createContext<AppState | null>(null)

/** Workers can be blocked (some file:// setups, strict policies): then the work runs on the main thread. */
function inWorker<T>(make: () => T): T | undefined {
  try {
    return make()
  } catch {
    return undefined
  }
}

async function createAppClient(settings: Settings, cityConfig: CityConfig, anchors: string[]): Promise<Client> {
  const verifier: Verifier | undefined = inWorker(() => workerVerifier(new VerifyWorker())) // SDK-5
  const miner: Miner | undefined = inWorker(() => workerMiner(new PowWorker())) // SDK-8
  // SDK-4, NFR-3: seen events and the outbox live in IndexedDB, per origin (APP-11).
  const storage = await indexedDbStore(`smartcity-${cityConfig.id}`).catch(() => memoryStore())
  return new Client({ city: cityConfig.id, relays: settings.relays, trustAnchors: anchors, verifier, miner, storage })
}

const anchorsOf = (settings: Settings, cityConfig: CityConfig) => settings.anchors ?? cityConfig.roots

export function ClientProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState(loadSettings)
  const cityConfig = CITIES.find((c) => c.id === settings.city) ?? CITIES[0]!
  const [sc, setSc] = useState<Client | null>(null)
  const [city, setCity] = useState<City | null>(null)
  const [identity, setIdentityState] = useState<Identity | null>(null)
  const [trustVersion, setTrustVersion] = useState(0)

  // One client per page load; later settings changes are applied to it.
  useEffect(() => {
    let client: Client | null = null
    let alive = true
    void createAppClient(settings, cityConfig, anchorsOf(settings, cityConfig)).then((c) => {
      if (!alive) return c.close()
      client = c
      setSc(c)
    })
    return () => {
      alive = false
      client?.close()
    }
  }, [])

  useEffect(() => {
    if (!sc) return
    let alive = true
    const resolve = () => void sc.resolveCity().then((c) => alive && setCity(c), () => {})
    resolve()
    void sc.trust.refresh().catch(() => {})
    const stopWatch = sc.trust.watch()
    const stopTrust = sc.trust.onChange(() => setTrustVersion((v) => v + 1))
    // GOAL-7: back online, send what waits without waiting for the next retry.
    const online = () => void sc.relays.connect().then(() => sc.outbox.flush())
    window.addEventListener('online', online)
    const timer = setInterval(resolve, 10 * 60_000)
    return () => {
      alive = false
      clearInterval(timer)
      stopWatch()
      stopTrust()
      window.removeEventListener('online', online)
    }
  }, [sc])

  if (!sc) return <div className="page muted">Abriendo almacenamiento local…</div>

  const updateSettings = (change: Partial<Settings>) => {
    const next = { ...settings, ...change }
    for (const url of settings.relays) if (!next.relays.includes(url)) sc.relays.remove(url)
    for (const url of next.relays) sc.relays.add(url)
    setSettings(next)
    saveSettings(next)
  }

  const setAnchors = async (anchors: string[] | null) => {
    const next = { ...settings, anchors }
    setSettings(next)
    saveSettings(next)
    await sc.trust.setAnchors(anchorsOf(next, cityConfig))
    setCity(sc.city)
    setTrustVersion((v) => v + 1)
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

  const anchors = anchorsOf(settings, cityConfig)
  return (
    <Context.Provider
      value={{ sc, settings, cityConfig, city, identity, anchors, trustVersion, updateSettings, setAnchors, setIdentity }}
    >
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

/** SDK-4: events waiting for a relay. */
export function useOutbox(): OutboxEntry[] {
  const { sc } = useApp()
  const [entries, setEntries] = useState<OutboxEntry[]>([])
  useEffect(() => sc.outbox.onChange(setEntries), [sc])
  return entries
}
