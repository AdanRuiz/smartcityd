import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { KIND, NOSTR_KIND, canonicalNdjson, utcDayRange } from '@smartcity/schemas'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { describe, expect, it } from 'vitest'
import { Client, type ArchiveDiscard, type ArchiveQuery, type Fetch, type NostrEvent } from '../src/index.js'
import { fakeNetwork } from './fake-relay.js'

const CITY = 'mx-gdl'
const RELAY = 'wss://a.example'
const DAY = '2025-10-08'
const { from: START, to: END } = utcDayRange(DAY)!
const NEXT = utcDayRange('2025-10-09')!.from

const sign = (sk: Uint8Array, kind: number, tags: string[][], content: unknown, created_at: number): NostrEvent =>
  finalizeEvent({ kind, tags, content: typeof content === 'string' ? content : JSON.stringify(content), created_at }, sk)

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')

const author = generateSecretKey()
const archiver = generateSecretKey()
const datasetTag = ['a', `${KIND.DATASET}:${'0'.repeat(64)}:air`]
const observation = (created_at: number, pm25: number) =>
  sign(author, KIND.OBSERVATION, [['c', CITY], datasetTag], { v: 1, obs: [{ ts: created_at, values: { pm25 } }] }, created_at)

/** A gzip file and the `snapshot` event announcing it, as the archiver publishes them. */
function snapshot(
  type: 'daily' | 'addendum' | 'monthly',
  name: string,
  range: { from: number; to: number },
  lines: string,
  urls: string[],
  sk = archiver,
) {
  const gzip = new Uint8Array(gzipSync(lines))
  const x = sha256(lines)
  const content = {
    v: 1, from: range.from, to: range.to, count: lines.split('\n').length - 1, format: 'ndjson+gzip', x,
    file: { name, x: sha256(gzip), size: gzip.length }, urls, policy: 'none',
  }
  const event = sign(sk, KIND.SNAPSHOT, [['c', CITY], ['t', type], ['x', x]], content, range.to + 3 * 86_400)
  return { gzip, event }
}

function setup(served: Record<string, Uint8Array>, events: NostrEvent[], extra: { ipfsGateways?: string[] } = {}) {
  const net = fakeNetwork(RELAY)
  for (const e of events) net.relay(RELAY).plant(e)
  const fetched: string[] = []
  const fetch: Fetch = async (url) => {
    fetched.push(url)
    const body = served[url]
    return { ok: body !== undefined, arrayBuffer: async () => (body ?? new Uint8Array()).slice().buffer }
  }
  const sc = new Client({ city: CITY, relays: [RELAY], WebSocket: net.WebSocket, queryTimeoutMs: 300, fetch, ...extra })
  return { sc, fetched }
}

async function readAll(sc: Client, query: ArchiveQuery): Promise<{ events: NostrEvent[]; discarded: ArchiveDiscard[] }> {
  const discarded: ArchiveDiscard[] = []
  const events: NostrEvent[] = []
  for await (const event of sc.archive.read({ onDiscard: (d) => discarded.push(d), ...query })) events.push(event)
  return { events, discarded }
}

describe('sc.archive.read (SNAP-6)', () => {
  const a = observation(START + 100, 10)
  const b = observation(START + 200, 20)
  const late = observation(START + 50, 5)
  const deletion = sign(author, NOSTR_KIND.DELETION, [['e', b.id]], '', START + 300)
  const daily = snapshot('daily', 'sc_mx-gdl_2025-10-08.ndjson.gz', { from: START, to: END }, canonicalNdjson([a, b]), [
    'https://r2.example/daily.gz',
  ])
  const addendum = snapshot('addendum', 'sc_mx-gdl_2025-10-08_a1.ndjson.gz', { from: START, to: END }, canonicalNdjson([late, deletion]), [
    'https://r2.example/a1.gz',
  ])

  it('joins the daily file and its addenda, applies their deletions and yields the day in order', async () => {
    const { sc } = setup({ 'https://r2.example/daily.gz': daily.gzip, 'https://r2.example/a1.gz': addendum.gzip }, [daily.event, addendum.event])
    const { events, discarded } = await readAll(sc, { from: DAY })
    expect(events.map((e) => e.id)).toEqual([late.id, a.id, deletion.id])
    expect(discarded).toEqual([])
    const only = await readAll(sc, { from: DAY, kinds: [KIND.OBSERVATION] })
    expect(only.events.map((e) => e.id)).toEqual([late.id, a.id])
    sc.close()
  })

  it('ignores a deletion signed by someone other than the author', async () => {
    const forged = sign(generateSecretKey(), NOSTR_KIND.DELETION, [['e', a.id]], '', START + 400)
    const add = snapshot('addendum', 'a1.gz', { from: START, to: END }, canonicalNdjson([forged]), ['https://r2.example/forged.gz'])
    const { sc } = setup({ 'https://r2.example/daily.gz': daily.gzip, 'https://r2.example/forged.gz': add.gzip }, [daily.event, add.event])
    const { events } = await readAll(sc, { from: DAY, kinds: [KIND.OBSERVATION] })
    expect(events.map((e) => e.id)).toEqual([a.id, b.id])
    sc.close()
  })

  it('takes the next source when one serves a file that does not match file.x, and the cid on a gateway', async () => {
    const tampered = new Uint8Array(gzipSync(canonicalNdjson([a])))
    const withCid = { ...daily, event: sign(archiver, KIND.SNAPSHOT, daily.event.tags, { ...JSON.parse(daily.event.content), urls: ['https://bad.example/d.gz'], cid: 'bafytest' }, daily.event.created_at) }
    const { sc, fetched } = setup(
      { 'https://bad.example/d.gz': tampered, 'https://gw.example/ipfs/bafytest': daily.gzip },
      [withCid.event],
      { ipfsGateways: ['https://down.example', 'https://gw.example/'] },
    )
    const { events, discarded } = await readAll(sc, { from: DAY })
    expect(events.map((e) => e.id)).toEqual([a.id, b.id])
    expect(fetched).toEqual(['https://bad.example/d.gz', 'https://down.example/ipfs/bafytest', 'https://gw.example/ipfs/bafytest'])
    expect(discarded).toEqual([])
    sc.close()
  })

  it('discards a file whose NDJSON does not match x, and reports it', async () => {
    const wrong = snapshot('daily', 'wrong.gz', { from: START, to: END }, canonicalNdjson([a]), ['https://r2.example/wrong.gz'])
    // Served with the right .gz hash but announced with another canonical hash.
    const content = { ...JSON.parse(wrong.event.content), x: 'f'.repeat(64) }
    const lying = sign(archiver, KIND.SNAPSHOT, [['c', CITY], ['t', 'daily'], ['x', content.x]], content, wrong.event.created_at)
    const { sc } = setup({ 'https://r2.example/wrong.gz': wrong.gzip }, [lying])
    const { events, discarded } = await readAll(sc, { from: DAY })
    expect(events).toEqual([])
    expect(discarded).toHaveLength(1)
    expect(discarded[0]!.snapshot).toBe(lying.id)
    expect(discarded[0]!.reason).toContain('does not match x')
    sc.close()
  })

  it('discards and reports an invalid line without invalidating the rest', async () => {
    const forgedLine = JSON.stringify({ ...b, content: JSON.stringify({ v: 1, obs: [{ ts: START + 200, values: { pm25: 999 } }] }) })
    const lines = `${JSON.stringify(a)}\n${forgedLine}\nnot json\n`
    const file = snapshot('daily', 'bad-lines.gz', { from: START, to: END }, lines, ['https://r2.example/bad-lines.gz'])
    const { sc } = setup({ 'https://r2.example/bad-lines.gz': file.gzip }, [file.event])
    const { events, discarded } = await readAll(sc, { from: DAY })
    expect(events.map((e) => e.id)).toEqual([a.id])
    expect(discarded.map((d) => [d.line, d.reason])).toEqual([
      [2, 'id or sig does not verify'],
      [3, 'line is not JSON'],
    ])
    sc.close()
  })

  it('joins the files of several archivers by id and downloads each x once', async () => {
    const other = generateSecretKey()
    const same = snapshot('daily', 'same.gz', { from: START, to: END }, canonicalNdjson([a, b]), ['https://r2.example/daily.gz'], other)
    const c = observation(START + 500, 30)
    const wider = snapshot('daily', 'wider.gz', { from: START, to: END }, canonicalNdjson([a, c]), ['https://r2.example/wider.gz'], other)
    const { sc, fetched } = setup(
      { 'https://r2.example/daily.gz': daily.gzip, 'https://r2.example/wider.gz': wider.gzip },
      [daily.event, same.event, wider.event],
    )
    const { events } = await readAll(sc, { from: DAY })
    expect(events.map((e) => e.id)).toEqual([a.id, b.id, c.id])
    expect(fetched.filter((u) => u.endsWith('daily.gz'))).toHaveLength(1)
    const { events: mine } = await readAll(sc, { from: DAY, archivers: [getPublicKey(archiver)] })
    expect(mine.map((e) => e.id)).toEqual([a.id, b.id])
    sc.close()
  })

  it('reads a range day by day and falls back to the monthly file for a day without its own', async () => {
    const d2 = observation(NEXT + 10, 40)
    const outside = observation(START - 10, 1)
    const month = { from: utcDayRange('2025-10-01')!.from, to: utcDayRange('2025-11-01')!.from }
    const monthly = snapshot('monthly', 'sc_mx-gdl_2025-10.ndjson.gz', month, canonicalNdjson([outside, a, b, d2]), [
      'https://r2.example/monthly.gz',
    ])
    const { sc, fetched } = setup({ 'https://r2.example/daily.gz': daily.gzip, 'https://r2.example/monthly.gz': monthly.gzip }, [
      daily.event,
      monthly.event,
    ])
    const { events } = await readAll(sc, { from: DAY, to: '2025-10-09' })
    expect(events.map((e) => e.id)).toEqual([a.id, b.id, d2.id])
    expect(fetched).toEqual(['https://r2.example/daily.gz', 'https://r2.example/monthly.gz'])
    sc.close()
  })

  it('rejects a malformed or inverted range before asking anyone', () => {
    const { sc } = setup({}, [])
    expect(() => sc.archive.read({ from: '2025-10-32' })).toThrow('not a UTC day')
    expect(() => sc.archive.read({ from: '2025-10-09', to: DAY })).toThrow('ends before it starts')
    sc.close()
  })
})
