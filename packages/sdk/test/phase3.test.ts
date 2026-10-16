import 'fake-indexeddb/auto'
import { KIND, NOSTR_KIND } from '@smartcity/schemas'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { describe, expect, it } from 'vitest'
import {
  Client,
  createClient,
  geoTags,
  getPow,
  indexedDbStore,
  localSigner,
  memoryStore,
  type ClientOptions,
  type LatLon,
  type NostrEvent,
} from '../src/index.js'
import { fakeNetwork } from './fake-relay.js'

const CITY = 'mx-gdl'
const A = 'wss://a.example'
const B = 'wss://b.example'
const SPOT: LatLon = [20.676543, -103.347891]
const now = () => Math.floor(Date.now() / 1000)
// Tests mine little: the default difficulty is exercised once, on its own.
const LIGHT_POW = { [KIND.REPORT]: 4 }

const sign = (sk: Uint8Array, kind: number, tags: string[][], content: unknown, created_at = now()): NostrEvent =>
  finalizeEvent({ kind, tags, content: typeof content === 'string' ? content : JSON.stringify(content), created_at }, sk)

const waitFor = async (test: () => boolean | Promise<boolean>, ms = 3000) => {
  const start = Date.now()
  while (!(await test())) {
    if (Date.now() - start > ms) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 10))
  }
}

function network(urls = [A, B]) {
  const net = fakeNetwork(...urls)
  const client = (extra: Partial<ClientOptions> = {}) =>
    new Client({ city: CITY, relays: urls, WebSocket: net.WebSocket, queryTimeoutMs: 300, retryBaseMs: 10, outboxRetryMs: 50, pow: LIGHT_POW, ...extra })
  return { net, client, urls }
}

/** An anchor and a roles list it signs. */
function rolesList(anchor: Uint8Array, entries: [string, string][], created_at = now()) {
  return sign(anchor, KIND.ROLES, [['d', CITY], ['c', CITY], ...entries.map(([pk, role]) => ['p', pk, role])], { v: 1 }, created_at)
}

const dataset = (sk: Uint8Array) =>
  sign(sk, KIND.DATASET, [['d', 'air'], ['c', CITY], ['t', 'ambiente']], {
    v: 1, name: 'Aire', license: 'CC0-1.0', mode: 'observation', geometry: 'point', fields: { pm25: { type: 'number' } },
  })

describe('outbox and local store (SDK-4, GOAL-7, NFR-3)', () => {
  it('queues when no relay is reachable and sends on reconnection', async () => {
    const { net, client } = network()
    for (const r of net.relays.values()) r.down = true
    const sk = generateSecretKey()
    const writer = client({ signer: localSigner(sk) })
    const res = await writer.datasets.define({ d: 'air', name: 'Aire', license: 'CC0-1.0', mode: 'observation', geometry: 'point', fields: { pm25: { type: 'number' } } })
    expect(res.accepted).toEqual([])
    expect(res.queued).toBe(true)
    expect(await writer.outbox.list()).toHaveLength(1)
    // While offline, what this device published is still visible to it.
    expect(await writer.datasets.list()).toHaveLength(1)
    for (const r of net.relays.values()) r.down = false
    await waitFor(() => net.relay(A).events.length === 1 && net.relay(B).events.length === 1)
    await waitFor(async () => (await writer.outbox.list()).length === 0)
    writer.close()
  })

  it('does not queue what every relay rejects for good', async () => {
    const { net, client } = network()
    for (const r of net.relays.values()) r.reject = () => 'invalid: no'
    const writer = client({ signer: localSigner(generateSecretKey()) })
    const res = await writer.publish({ kind: 1, tags: [], content: 'x' })
    expect(res.queued).toBe(false)
    expect(await writer.outbox.list()).toHaveLength(0)
  })

  it('keeps showing what it saw when every relay is down (NFR-3)', async () => {
    const { net, client } = network()
    const sk = generateSecretKey()
    net.relay(A).plant(dataset(sk))
    const store = memoryStore()
    const first = client({ storage: store })
    expect(await first.datasets.list()).toHaveLength(1)
    first.close() // writes what it saw
    for (const r of net.relays.values()) r.down = true
    const later = client({ storage: store })
    const offline = await later.datasets.list()
    expect(offline.map((d) => d.d)).toEqual(['air'])
  })

  it('keeps the outbox in IndexedDB across sessions', async () => {
    const { net, urls } = network()
    for (const r of net.relays.values()) r.down = true
    const name = `test-${Math.random()}`
    const sk = generateSecretKey()
    const opts = { city: CITY, relays: urls, WebSocket: net.WebSocket, queryTimeoutMs: 200, retryBaseMs: 10, outboxRetryMs: 50 }
    const before = await createClient({ ...opts, storage: await indexedDbStore(name), signer: localSigner(sk) })
    expect((await before.publish({ kind: 1, tags: [], content: 'offline' })).queued).toBe(true)
    before.close()
    for (const r of net.relays.values()) r.down = false
    const after = await createClient({ ...opts, storage: await indexedDbStore(name) })
    await waitFor(() => net.relay(A).events.some((e) => e.content === 'offline'))
    await waitFor(async () => (await after.outbox.list()).length === 0)
    after.close()
  })
})

describe('trust (TRUST-4, TRUST-5, TRUST-7, TRUST-10, docs/spec/04)', () => {
  it('computes levels from the roles lists of the anchors only', async () => {
    const { net } = network([A])
    const anchor = generateSecretKey()
    const stranger = generateSecretKey()
    const [authority, blocked, moderator, owner, device, someone] = Array.from({ length: 6 }, () => generateSecretKey())
    const pk = getPublicKey
    net.relay(A).plant(
      rolesList(anchor, [
        [pk(authority!), 'authority'],
        [pk(blocked!), 'blocked'],
        [pk(moderator!), 'moderator'],
        [pk(owner!), 'source'],
      ]),
    )
    // TRUST-4: a list signed by a key that is not an anchor does not count.
    net.relay(A).plant(rolesList(stranger, [[pk(someone!), 'authority']]))
    const sc = await createClient({ city: CITY, relays: [A], WebSocket: net.WebSocket, queryTimeoutMs: 200, trustAnchors: [pk(anchor)] })
    const ev = (sk: Uint8Array, tags: string[][] = []) => sign(sk, 1, tags, 'x')
    expect(sc.trustOf(ev(authority!))).toBe('verified')
    expect(sc.trustOf(ev(blocked!))).toBe('flagged')
    expect(sc.trustOf(ev(someone!))).toBe('community')
    expect(sc.trust.hasRole(pk(anchor), 'authority')).toBe(true)

    // A device key listed in `keys` of a source whose owner has a role (ID-5).
    const ds = `${KIND.DATASET}:${pk(owner!)}:air`
    const sourceAddr = `${KIND.SOURCE}:${pk(owner!)}:balcon`
    net.relay(A).plant(sign(owner!, KIND.SOURCE, [['d', 'balcon'], ['c', CITY], ['a', ds]], { v: 1, name: 'B', status: 'active', keys: [pk(device!)] }))
    await sc.query([{ kinds: [KIND.SOURCE] }])
    const obs = (sk: Uint8Array) =>
      sign(sk, KIND.OBSERVATION, [['c', CITY], ['a', ds], ['a', sourceAddr], ...geoTags(SPOT)], { v: 1, loc: SPOT, obs: [{ ts: now(), values: { pm25: 3 } }] })
    expect(sc.trustOf(obs(device!))).toBe('verified')
    expect(sc.trustOf(obs(someone!))).toBe('community')

    // A moderator's label hides an event (08, moderation).
    const target = ev(someone!)
    net.relay(A).plant(sign(moderator!, NOSTR_KIND.LABEL, [['L', 'moderation'], ['l', 'spam', 'moderation'], ['e', target.id]], ''))
    await sc.trust.refresh()
    expect(sc.trustOf(target)).toBe('flagged')

    // TRUST-10: without that anchor, its attestations stop counting.
    let notified = 0
    sc.trust.onChange(() => notified++)
    await sc.trust.setAnchors([])
    expect(sc.trustOf(ev(authority!))).toBe('community')
    expect(sc.trustOf(ev(blocked!))).toBe('community')
    await waitFor(() => notified > 0)
    sc.close()
  })

  it('filters readings by level (TRUST-5)', async () => {
    const { net, client } = network([A])
    const anchor = generateSecretKey()
    const [good, bad] = [generateSecretKey(), generateSecretKey()]
    net.relay(A).plant(rolesList(anchor, [[getPublicKey(good), 'source'], [getPublicKey(bad), 'blocked']]))
    const ds = `${KIND.DATASET}:${getPublicKey(good)}:air`
    const obs = (sk: Uint8Array, pm25: number) =>
      sign(sk, KIND.OBSERVATION, [['c', CITY], ['a', ds], ...geoTags(SPOT)], { v: 1, loc: SPOT, obs: [{ ts: now(), values: { pm25 } }] })
    net.relay(A).plant(obs(good, 1))
    net.relay(A).plant(obs(bad, 2))
    net.relay(A).plant(obs(generateSecretKey(), 3))
    const sc = client({ trustAnchors: [getPublicKey(anchor)] })
    await sc.trust.refresh()
    const all = await sc.observations.query({ dataset: ds })
    expect(all.map((r) => [r.values.pm25, r.trust])).toEqual(expect.arrayContaining([[1, 'verified'], [2, 'flagged'], [3, 'community']]))
    const shown = await sc.observations.query({ dataset: ds, trust: ['verified', 'community'] })
    expect(shown.map((r) => r.values.pm25).sort()).toEqual([1, 3])
  })
})

describe('reports (docs/spec/03, PRIV-3, PRIV-5, SPAM-1)', () => {
  it('uses a new key per report, rounds the location and needs no signer', async () => {
    const { net, client } = network([A])
    const citizen = client()
    const one = await citizen.reports.create({ category: 'Bache', title: 'Bache profundo', loc: SPOT })
    const two = await citizen.reports.create({ category: 'alumbrado', title: 'Lámpara apagada', loc: SPOT })
    expect(one.accepted).toEqual([A])
    expect(one.pubkey).not.toBe(two.pubkey)
    const stored = net.relay(A).events.find((e) => e.id === one.id)!
    expect(JSON.parse(stored.content).loc).toEqual([20.6765, -103.3479])
    expect(stored.tags).toContainEqual(['t', 'bache'])
    expect(getPow(stored.id)).toBeGreaterThanOrEqual(4)
  })

  it('mines 16 bits for a report by default', async () => {
    const { net } = network([A])
    const sc = new Client({ city: CITY, relays: [A], WebSocket: net.WebSocket })
    const res = await sc.reports.create({ category: 'fuga', title: 'Fuga de agua', loc: SPOT })
    expect(getPow(res.id)).toBeGreaterThanOrEqual(16)
    expect(net.relay(A).events[0]!.tags.find((t) => t[0] === 'nonce')?.[2]).toBe('16')
  })

  it('mines again when a relay asks for more work (SDK-8)', async () => {
    const { net, client } = network([A])
    net.relay(A).reject = (e) => (e.kind === KIND.REPORT && getPow(e.id) < 10 ? 'pow: difficulty 10 required' : null)
    const sc = client({ pow: {} })
    const res = await sc.reports.create({ category: 'basura', title: 'Basura', loc: SPOT })
    expect(res.accepted).toEqual([A])
    expect(getPow(res.id)).toBeGreaterThanOrEqual(10)
  })

  it('takes the status from authority updates only, and shows the rest as comments', async () => {
    const { client } = network([A])
    const anchor = generateSecretKey()
    const official = generateSecretKey()
    const neighbour = generateSecretKey()
    const citizen = client()
    const created = await citizen.reports.create({ category: 'bache', title: 'Bache', loc: SPOT })

    const root = client({ signer: localSigner(anchor) })
    await root.publish({ kind: KIND.ROLES, tags: [['d', CITY], ['p', getPublicKey(official), 'authority']], content: { v: 1 } })

    const other = client({ signer: localSigner(neighbour) })
    await other.reports.update(created.id, { status: 'resolved', body: 'Ya lo taparon' })
    const viewer = client({ trustAnchors: [getPublicKey(anchor)] })
    await viewer.trust.refresh()
    let report = (await viewer.reports.get(created.id))!
    expect(report.status).toBe('open')
    expect(report.updates).toHaveLength(1)
    expect(report.updates[0]!.official).toBe(false)

    const city = client({ signer: localSigner(official), trustAnchors: [getPublicKey(anchor)] })
    await city.reports.update({ id: created.id, pubkey: created.pubkey }, { status: 'in_progress' })
    await new Promise((r) => setTimeout(r, 1100)) // a later second, so the order is clear
    await city.reports.update({ id: created.id, pubkey: created.pubkey }, { status: 'resolved', body: 'Reparado' })
    report = (await viewer.reports.get(created.id))!
    expect(report.status).toBe('resolved')
    expect(report.statusUpdate?.pubkey).toBe(getPublicKey(official))
    expect(await viewer.reports.query({ status: 'open' })).toHaveLength(0)
    expect(await viewer.reports.query({ category: 'bache', bbox: [20.6, -103.4, 20.7, -103.3] })).toHaveLength(1)
  })

  it('creates a report offline and sends it on reconnection (phase 3 done criterion)', async () => {
    const { net, client } = network()
    for (const r of net.relays.values()) r.down = true
    const sc = client()
    const res = await sc.reports.create({ category: 'bache', title: 'Sin red', loc: SPOT })
    expect(res.queued).toBe(true)
    expect((await sc.reports.query()).map((r) => r.title)).toEqual(['Sin red'])
    for (const r of net.relays.values()) r.down = false
    await waitFor(() => net.relay(A).events.some((e) => e.id === res.id))
    const other = client()
    expect((await other.reports.get(res.id))?.title).toBe('Sin red')
  })
})
