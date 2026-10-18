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
import { createContext, Fragment, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { cityForPlace } from './cities'
import { CITIES, type CityConfig } from './config'
import { usePlace } from './geo/store'
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

/** Anchors in use for a city: the user's choice or, by default, the roots of the build (TRUST-1, TRUST-2, APP-18). */
const anchorsOf = (settings: Settings, cityConfig: CityConfig) => settings.anchors[cityConfig.id] ?? cityConfig.roots

export function ClientProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState(loadSettings)
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  // APP-17: the city of the data follows the place on the map; a place without a city keeps the last one.
  const place = usePlace()
  const lastCity = useRef<CityConfig>(CITIES.find((c) => c.id === settings.city) ?? CITIES[0]!)
  const wanted = (place && cityForPlace(place.place)) ?? lastCity.current
  lastCity.current = wanted
  const [active, setActive] = useState<{ sc: Client; cityConfig: CityConfig } | null>(null)
  const current = useRef<Client | null>(null)
  const signer = useRef<Signer | null>(null)
  const [city, setCity] = useState<City | null>(null)
  const [identity, setIdentityState] = useState<Identity | null>(null)
  const [trustVersion, setTrustVersion] = useState(0)

  // One client per city of the data (its own local store, APP-11); the previous one closes once the new one is up.
  useEffect(() => {
    let alive = true
    void createAppClient(settingsRef.current, wanted, anchorsOf(settingsRef.current, wanted)).then((c) => {
      if (!alive) return c.close()
      if (signer.current) c.setSigner(signer.current)
      const old = current.current
      current.current = c
      setCity(null)
      setActive({ sc: c, cityConfig: wanted })
      old?.close()
    })
    return () => {
      alive = false
    }
  }, [wanted.id])
  useEffect(() => () => current.current?.close(), [])

  const sc = active?.sc ?? null
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

  if (!active) return <div className="page muted">Abriendo almacenamiento local…</div>
  const { cityConfig } = active

  const updateSettings = (change: Partial<Settings>) => {
    const next = { ...settings, ...change }
    for (const url of settings.relays) if (!next.relays.includes(url)) active.sc.relays.remove(url)
    for (const url of next.relays) active.sc.relays.add(url)
    setSettings(next)
    saveSettings(next)
  }

  /** TRUST-2, APP-18: for the city of the data only; null goes back to the roots of the build. */
  const setAnchors = async (anchors: string[] | null) => {
    const byCity = { ...settings.anchors }
    if (anchors === null) delete byCity[cityConfig.id]
    else byCity[cityConfig.id] = anchors
    const next = { ...settings, anchors: byCity }
    setSettings(next)
    saveSettings(next)
    await active.sc.trust.setAnchors(anchorsOf(next, cityConfig))
    setCity(active.sc.city)
    setTrustVersion((v) => v + 1)
  }

  const setIdentity = async (next: Signer | null, kind: IdentityKind = 'local') => {
    signer.current = next
    if (!next) {
      active.sc.setSigner(undefined)
      setIdentityState(null)
      return
    }
    const pubkey = await next.getPublicKey()
    active.sc.setSigner(next)
    setIdentityState({ kind, pubkey })
  }

  const anchors = anchorsOf(settings, cityConfig)
  return (
    <Context.Provider
      value={{ sc: active.sc, settings, cityConfig, city, identity, anchors, trustVersion, updateSettings, setAnchors, setIdentity }}
    >
      {/* A new city of the data starts every page afresh. */}
      <Fragment key={cityConfig.id}>{children}</Fragment>
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
