import { KIND } from '@smartcity/schemas'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { describe, expect, it } from 'vitest'
import {
  Client,
  ValidationError,
  coverBBox,
  createClient,
  decryptSecretKey,
  encodeGeohash,
  encryptSecretKey,
  geoTags,
  inBBox,
  localSigner,
  type BBox,
  type ClientOptions,
  type LatLon,
  type NostrEvent,
} from '../src/index.js'
import { fakeNetwork } from './fake-relay.js'

const CITY = 'mx-gdl'
const A = 'wss://a.example'
const B = 'wss://b.example'
const C = 'wss://c.example'
const BALCON: LatLon = [20.6668, -103.3918]
const now = () => Math.floor(Date.now() / 1000)

const airFields = {
  pm25: { type: 'number' as const, unit: 'ug/m3', min: 0, max: 1000 },
  temp: { type: 'number' as const, unit: 'Cel' },
}

function setup(urls = [A, B, C], options: Partial<ClientOptions> = {}) {
  const net = fakeNetwork(...urls)
  const sk = generateSecretKey()
  const client = (extra: Partial<ClientOptions> = {}) =>
    new Client({ city: CITY, relays: urls, WebSocket: net.WebSocket, queryTimeoutMs: 300, retryBaseMs: 10, ...options, ...extra })
  return { net, sk, pk: getPublicKey(sk), writer: client({ signer: localSigner(sk) }), reader: client() }
}

const sign = (sk: Uint8Array, kind: number, tags: string[][], content: unknown, created_at = now()): NostrEvent =>
  finalizeEvent({ kind, tags, content: JSON.stringify(content), created_at }, sk)

const waitFor = async (test: () => boolean, ms = 2000) => {
  const start = Date.now()
  while (!test()) {
    if (Date.now() - start > ms) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('geohash (EVT-3, SDK-6)', () => {
  it('encodes the reference point', () => {
    expect(encodeGeohash(57.64911, 10.40744, 11)).toBe('u4pruydqqvj')
  })

  it('makes three g tags of the same point', () => {
    const [g4, g5, g6] = geoTags(BALCON).map((t) => t[1]!)
    expect([g4!.length, g5!.length, g6!.length]).toEqual([4, 5, 6])
    expect(g6!.startsWith(g5!) && g5!.startsWith(g4!)).toBe(true)
  })

  it('covers a bbox with cells that contain every point inside it', () => {
    const bbox: BBox = [20.66, -103.4, 20.68, -103.38]
    const { precision, cells } = coverBBox(bbox)
    expect(precision).toBe(6)
    for (let i = 0; i <= 10; i++) {
      for (let j = 0; j <= 10; j++) {
        const lat = 20.66 + (0.02 * i) / 10
        const lon = -103.4 + (0.02 * j) / 10
        expect(cells).toContain(encodeGeohash(lat, lon, precision))
      }
    }
  })

  it('drops to a coarser precision for a large box', () => {
    const city: BBox = [20.55, -103.47, 20.78, -103.24]
    const { precision, cells } = coverBBox(city)
    expect(precision).toBeLessThan(6)
    expect(cells.length).toBeLessThanOrEqual(48)
  })

  it('clips exactly', () => {
    expect(inBBox(BALCON, [20.6, -103.4, 20.7, -103.3])).toBe(true)
    expect(inBBox(BALCON, [20.6, -103.39, 20.7, -103.3])).toBe(false)
  })
})

describe('signers (ID-1, ID-2, SEC-3)', () => {
  it('signs with a local key without exposing it', async () => {
    const sk = generateSecretKey()
    const signer = localSigner(sk)
    expect(Object.values(signer).some((v) => v instanceof Uint8Array)).toBe(false)
    const event = await signer.signEvent({ kind: 1, created_at: now(), tags: [], content: 'x' })
    expect(event.pubkey).toBe(getPublicKey(sk))
  })

  it('encrypts a key at rest with NIP-49 and opens it with the passphrase only', () => {
    const sk = generateSecretKey()
    const ncryptsec = encryptSecretKey(sk, 'frase larga')
    expect(ncryptsec.startsWith('ncryptsec1')).toBe(true)
    expect(decryptSecretKey(ncryptsec, 'frase larga')).toEqual(sk)
    expect(() => decryptSecretKey(ncryptsec, 'otra')).toThrow()
  })
})

describe('publishing', () => {
  it('validates before signing and sends nothing when invalid (SDK-1)', async () => {
    const { writer, net } = setup()
    await expect(writer.publish({ kind: KIND.OBSERVATION, tags: [['a', 'nope']], content: { v: 1, obs: [] } })).rejects.toThrow(
      ValidationError,
    )
    expect(net.relay(A).received).toHaveLength(0)
  })

  it('adds the c tag and the three g tags (SDK-2)', async () => {
    const { writer, pk, net } = setup()
    const def = await writer.datasets.define({ d: 'air', name: 'Aire', license: 'CC0-1.0', mode: 'observation', geometry: 'point', fields: airFields })
    await writer.observations.publish({ dataset: def.address, loc: BALCON, obs: [{ ts: now(), values: { pm25: 12 } }] })
    const stored = net.relay(A).events.find((e) => e.kind === KIND.OBSERVATION)!
    expect(stored.pubkey).toBe(pk)
    expect(stored.tags).toContainEqual(['c', CITY])
    expect(stored.tags.filter((t) => t[0] === 'g').map((t) => t[1])).toEqual(geoTags(BALCON).map((t) => t[1]))
  })

  it('resolves at the first OK and keeps retrying the others (SDK-3, REPL-1)', async () => {
    const { writer, net } = setup()
    net.relay(B).down = true
    net.relay(C).reject = () => 'rate-limited: slow down'
    const res = await writer.datasets.define({ d: 'air', name: 'Aire', license: 'CC0-1.0', mode: 'observation', geometry: 'point', fields: airFields })
    expect(res.accepted).toEqual([A])
    expect(res.queued).toBe(false)
    net.relay(C).reject = () => null
    await waitFor(() => net.relay(C).events.length === 1)
    net.relay(B).down = false
    await waitFor(() => net.relay(B).events.length === 1, 5000)
  })

  it('reports permanent rejections', async () => {
    const { writer, net } = setup([A, B])
    net.relay(A).reject = () => 'blocked: not here'
    net.relay(B).reject = () => 'invalid: schema'
    const res = await writer.datasets.define({ d: 'air', name: 'Aire', license: 'CC0-1.0', mode: 'observation', geometry: 'point', fields: airFields })
    expect(res.accepted).toEqual([])
    expect(res.rejected.map((r) => r.reason).sort()).toEqual(['blocked: not here', 'invalid: schema'])
  })

  it('checks values against the dataset fields (EVT-8)', async () => {
    const { writer } = setup()
    const def = await writer.datasets.define({ d: 'air', name: 'Aire', license: 'CC0-1.0', mode: 'observation', geometry: 'point', fields: airFields })
    await expect(
      writer.observations.publish({ dataset: def.address, loc: BALCON, obs: [{ ts: now(), values: { pm25: -3 } }] }),
    ).rejects.toThrow(/below the minimum/)
    await expect(
      writer.observations.publish({ dataset: def.address, loc: BALCON, obs: [{ ts: now(), values: { ruido: 3 } }] }),
    ).rejects.toThrow(/not a field/)
  })

  it('buffers readings into one event (SDK-7, DATA-9)', async () => {
    const { writer, net } = setup([A])
    const def = await writer.datasets.define({ d: 'air', name: 'Aire', license: 'CC0-1.0', mode: 'observation', geometry: 'point', fields: airFields })
    const buf = writer.observations.buffer({ dataset: def.address, loc: BALCON }, { maxItems: 3 })
    await buf.add({ ts: now() - 2, values: { pm25: 1 } })
    await buf.add({ ts: now() - 1, values: { pm25: 2 } })
    expect(net.relay(A).events.filter((e) => e.kind === KIND.OBSERVATION)).toHaveLength(0)
    const res = await buf.add({ ts: now(), values: { pm25: 3 } })
    expect(res?.accepted).toEqual([A])
    const obs = net.relay(A).events.filter((e) => e.kind === KIND.OBSERVATION)
    expect(obs).toHaveLength(1)
    expect(JSON.parse(obs[0]!.content).obs).toHaveLength(3)
    expect(await buf.flush()).toBeNull()
  })

  it('a client without signer is read-only (ID-3)', async () => {
    const { reader } = setup()
    await expect(reader.publish({ kind: 1, tags: [], content: 'x' })).rejects.toThrow(/read-only/)
  })
})

describe('reading (SDK-5, REPL-2, DATA-3, DATA-6)', () => {
  it('merges relays, deduplicates, and drops bad signatures and schema failures', async () => {
    const { net, sk, pk, reader } = setup([A, B])
    const ds = `${KIND.DATASET}:${pk}:air`
    const obs = (pm25: number) => sign(sk, KIND.OBSERVATION, [['c', CITY], ['a', ds], ...geoTags(BALCON)], { v: 1, loc: BALCON, obs: [{ ts: now(), values: { pm25 } }] })
    const good = obs(1)
    const onlyB = obs(2)
    const forged = { ...obs(3), content: JSON.stringify({ v: 1, loc: BALCON, obs: [{ ts: now(), values: { pm25: 999 } }] }) }
    const badSchema = sign(sk, KIND.OBSERVATION, [['c', CITY], ['a', ds]], { v: 1, obs: [] })
    net.relay(A).plant(good)
    net.relay(B).plant(good)
    net.relay(B).plant(onlyB)
    net.relay(A).plant(forged)
    net.relay(A).plant(badSchema)
    const rows = await reader.observations.query({ dataset: ds })
    expect(rows.map((r) => r.values.pm25).sort()).toEqual([1, 2])
  })

  it('drops events from more than 15 minutes in the future (DATA-4)', async () => {
    const { net, sk, pk, reader } = setup([A])
    const ds = `${KIND.DATASET}:${pk}:air`
    net.relay(A).plant(sign(sk, KIND.OBSERVATION, [['c', CITY], ['a', ds]], { v: 1, obs: [{ ts: now(), values: { pm25: 1 } }] }, now() + 3600))
    expect(await reader.observations.query({ dataset: ds })).toEqual([])
  })

  it('keeps the newest addressable event (DATA-3)', async () => {
    const { net, sk, reader } = setup([A, B])
    const def = (name: string, at: number) =>
      sign(sk, KIND.DATASET, [['d', 'air'], ['c', '*'], ['t', 'ambiente']], { v: 1, name, license: 'CC0-1.0', mode: 'observation', geometry: 'point', fields: airFields }, at)
    net.relay(A).plant(def('vieja', now() - 100))
    net.relay(B).plant(def('nueva', now() - 10))
    const list = await reader.datasets.list()
    expect(list.map((d) => d.content.name)).toEqual(['nueva'])
  })

  it('clips a bbox query to the box (SDK-6)', async () => {
    const { writer, reader, net } = setup([A])
    const def = await writer.datasets.define({ d: 'air', name: 'Aire', license: 'CC0-1.0', mode: 'observation', geometry: 'point', fields: airFields })
    await writer.observations.publish({ dataset: def.address, loc: BALCON, obs: [{ ts: now(), values: { pm25: 1 } }] })
    await writer.observations.publish({ dataset: def.address, loc: [20.7, -103.3], obs: [{ ts: now(), values: { pm25: 2 } }] })
    const rows = await reader.observations.query({ dataset: def.address, bbox: [20.66, -103.4, 20.67, -103.39] })
    expect(rows.map((r) => r.values.pm25)).toEqual([1])
    const req = net.relay(A).received.findLast((m) => m[0] === 'REQ')!
    expect((req[2] as { '#g': string[] })['#g'].length).toBeGreaterThan(0)
  })

  it('delivers new readings once to a subscriber, from several relays (NFR-1 path)', async () => {
    const { writer, reader } = setup([A, B])
    const def = await writer.datasets.define({ d: 'air', name: 'Aire', license: 'CC0-1.0', mode: 'observation', geometry: 'point', fields: airFields })
    const got: number[] = []
    let eose = false
    const close = reader.observations.subscribe({ dataset: def.address }, (r) => got.push(r.values.pm25 as number), () => (eose = true))
    await waitFor(() => eose)
    await writer.observations.publish({ dataset: def.address, loc: BALCON, obs: [{ ts: now(), values: { pm25: 7 } }] })
    await waitFor(() => got.length === 1)
    await new Promise((r) => setTimeout(r, 50))
    expect(got).toEqual([7])
    close()
  })

  it('resubscribes after a relay drops the connection', async () => {
    const { writer, reader, net } = setup([A])
    const def = await writer.datasets.define({ d: 'air', name: 'Aire', license: 'CC0-1.0', mode: 'observation', geometry: 'point', fields: airFields })
    const got: number[] = []
    let eose = false
    const close = reader.observations.subscribe({ dataset: def.address }, (r) => got.push(r.values.pm25 as number), () => (eose = true))
    await waitFor(() => eose)
    net.relay(A).disconnectAll()
    await waitFor(() => reader.relays.status()[0]!.state === 'closed')
    await waitFor(() => reader.relays.status()[0]!.state === 'open', 3000)
    await writer.observations.publish({ dataset: def.address, loc: BALCON, obs: [{ ts: now(), values: { pm25: 8 } }] })
    await waitFor(() => got.includes(8))
    close()
  })
})

describe('city and relays (REPL-4, REPL-6, TRUST-1, TRUST-3, SDK-10)', () => {
  it('takes the definition signed by an anchor and adds its relays', async () => {
    const net = fakeNetwork(A, B, C)
    const root = generateSecretKey()
    const stranger = generateSecretKey()
    const city = (sk: Uint8Array, relays: string[], at = now()) =>
      sign(sk, KIND.CITY, [['d', CITY]], { v: 1, name: 'Guadalajara', bbox: [20.55, -103.47, 20.78, -103.24], tz: 'America/Mexico_City', relays, roots: [getPublicKey(root)] }, at)
    net.relay(A).plant(city(root, [B]))
    net.relay(A).plant(city(stranger, [C], now() + 5))
    const sc = await createClient({ city: CITY, relays: [A], trustAnchors: [getPublicKey(root)], WebSocket: net.WebSocket, queryTimeoutMs: 300 })
    expect(sc.city?.content.relays).toEqual([B])
    expect(sc.relays.status().map((r) => r.url)).toEqual([A, B])
    expect((await sc.cityCandidates()).length).toBe(2)
    sc.close()
  })

  it('does not choose a city without anchors (TRUST-3)', async () => {
    const net = fakeNetwork(A)
    const sc = await createClient({ city: CITY, relays: [A], WebSocket: net.WebSocket, queryTimeoutMs: 300 })
    expect(sc.city).toBeNull()
  })

  it('exposes the state and latency of each relay', async () => {
    const { reader, net } = setup([A, B])
    net.relay(B).down = true
    const seen: string[] = []
    reader.relays.onChange((s) => seen.push(s.map((r) => `${r.url}=${r.state}`).join(',')))
    await reader.datasets.list()
    const [a, b] = reader.relays.status()
    expect(a!.state).toBe('open')
    expect(a!.latencyMs).not.toBeNull()
    expect(b!.state).toBe('closed')
    expect(b!.lastError).toMatch(/connection/)
    expect(seen.length).toBeGreaterThan(1)
  })

  it('rejects relay URLs that are not ws(s)', () => {
    const { reader } = setup([A])
    expect(() => reader.relays.add('https://x.example')).toThrow()
  })
})
