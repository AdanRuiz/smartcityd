import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { KIND } from '@smartcity/schemas'
import { describe, expect, it } from 'vitest'
import type { NostrEvent } from '../src/event.js'
import { exportDay } from '../src/export.js'
import { checkSnapshotFile } from '../src/import.js'
import { sqlFileDb, sqlLiteral } from '../src/sql.js'
import { Store } from '../src/store.js'
import { CITY, G, NOW, airDataset, dataset, deletion, key, observation, relay, report, sign } from './helpers.js'

const DAY = 86_400
// 40 days before NOW (2025-10-09): past the default MAX_EVENT_AGE_DAYS = 30.
const OLD = NOW - 40 * DAY
const OLD_DAY = '2025-08-30'
const FILE = `sc_${CITY}_${OLD_DAY}.ndjson.gz`
// As read from a file: without the verification that nostr-tools caches on the objects it signs.
const fromJson = (event: NostrEvent): NostrEvent => JSON.parse(JSON.stringify(event)) as NostrEvent
const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')

async function dayOf(store: Store, day = OLD_DAY): Promise<string> {
  const result = await exportDay(store, new URLSearchParams({ c: CITY, day }))
  if ('error' in result) throw new Error(result.error)
  return result.body
}

/** The archived day of a relay that took old events (as a mirror or an earlier import would). */
async function archivedDay() {
  const source = relay({ MAX_EVENT_AGE_DAYS: '0' })
  const { sk, pk } = key()
  const events = [observation(sk, pk, OLD), observation(sk, pk, OLD + 1), observation(sk, pk, OLD - 600), dataset(sk, 'Aire', OLD - 300)]
  for (const event of events) expect((await source.publish(event)).ok).toBe(true)
  return { sk, pk, events, ndjson: await dayOf(source.store) }
}

function snapshotFor(sk: Uint8Array, ndjson: string, file: Uint8Array, x = sha256(ndjson)): NostrEvent {
  return sign(
    sk,
    KIND.SNAPSHOT,
    [['c', CITY], ['t', 'daily'], ['x', x]],
    {
      v: 1,
      from: OLD - (OLD % DAY),
      to: OLD - (OLD % DAY) + DAY,
      count: ndjson.trimEnd().split('\n').length,
      format: 'ndjson+gzip',
      x: sha256(ndjson),
      file: { name: FILE, x: sha256(file), size: file.length },
      urls: [`https://archive.example/${FILE}`],
      policy: 'none',
    },
    OLD + 3 * DAY,
  )
}

describe('snapshot import (docs/spec/07, RELAY-5, NFR-4)', () => {
  it('rejects an event older than the maximum from clients and accepts it by import (test 10)', async () => {
    const { events, ndjson } = await archivedDay()
    const target = relay()
    for (const event of events.filter((e) => e.kind === KIND.OBSERVATION)) {
      expect(await target.publish(event)).toMatchObject({ ok: false, message: 'invalid: too old' })
    }
    const result = await target.importNdjson(ndjson)
    expect(result.invalid).toEqual([])
    expect(result.stored.map((e) => e.id).sort()).toEqual(events.map((e) => e.id).sort())
  })

  it('rebuilds an empty relay from a day: the same canonical NDJSON comes out', async () => {
    const { ndjson } = await archivedDay()
    const target = relay()
    await target.importNdjson(ndjson)
    expect(await dayOf(target.store)).toBe(ndjson)

    const again = await target.importNdjson(ndjson)
    expect(again).toMatchObject({ stored: [], duplicates: 4, invalid: [] })
  })

  it('discards and reports invalid lines without dropping the rest (SNAP-6)', async () => {
    const { sk, pk } = key()
    const good = observation(sk, pk, OLD)
    const tampered = { ...observation(sk, pk, OLD + 1), content: '{"v":1,"obs":[]}' }
    const elsewhere = sign(sk, KIND.OBSERVATION, [['c', 'mx-mty'], ['a', airDataset(pk)], ...G], {
      v: 1,
      obs: [{ ts: OLD, values: { pm25: 3 } }],
    }, OLD)
    const lines = [JSON.stringify(good), JSON.stringify(tampered), '{not json', JSON.stringify(elsewhere)]
    const result = await relay({ CITIES: CITY }).importNdjson(lines.join('\n') + '\n')
    expect(result.stored.map((e) => e.id)).toEqual([good.id])
    expect(result.invalid).toEqual([
      { line: 2, id: tampered.id, reason: 'invalid: id does not match the event' },
      { line: 3, id: '', reason: 'invalid: line is not JSON' },
      { line: 4, id: elsewhere.id, reason: 'restricted: city mx-mty is not served by this relay' },
    ])
  })

  it('keeps the operator policy: proof of work for reports from keys without a role', async () => {
    const { sk } = key()
    const result = await relay().importNdjson(JSON.stringify(report(sk, 0, OLD)))
    expect(result.invalid[0]?.reason).toMatch(/^pow:/)
  })
})

describe('checkSnapshotFile (SNAP-6)', () => {
  async function fixture() {
    const { sk, ndjson } = await archivedDay()
    const file = new Uint8Array(gzipSync(ndjson))
    return { sk, ndjson, file, snapshot: snapshotFor(sk, ndjson, file) }
  }

  it('accepts a file that matches its snapshot', async () => {
    const { ndjson, file, snapshot } = await fixture()
    expect(await checkSnapshotFile(file, ndjson, snapshot)).toBeNull()
  })

  it('rejects a file whose size, sha256 or canonical hash does not match', async () => {
    const { sk, ndjson, file, snapshot } = await fixture()
    expect(await checkSnapshotFile(file.slice(1), ndjson, snapshot)).toMatch(/^file size/)
    const flipped = file.slice()
    flipped[10] = (flipped[10] ?? 0) ^ 1
    expect(await checkSnapshotFile(flipped, ndjson, snapshot)).toBe('sha256 of the file does not match file.x')
    const shorter = ndjson.split('\n').slice(1).join('\n')
    expect(await checkSnapshotFile(file, shorter, snapshot)).toBe('sha256 of the uncompressed NDJSON does not match x')
    const badTag = snapshotFor(sk, ndjson, file, 'c'.repeat(64))
    expect(await checkSnapshotFile(file, ndjson, badTag)).toBe('sha256 of the uncompressed NDJSON does not match x')
  })

  it('rejects a snapshot event that does not verify or is not a snapshot', async () => {
    const { sk, ndjson, file, snapshot } = await fixture()
    expect(await checkSnapshotFile(file, ndjson, fromJson({ ...snapshot, created_at: snapshot.created_at + 1 }))).toMatch(/does not verify$/)
    expect(await checkSnapshotFile(file, ndjson, sign(sk, KIND.OBSERVATION, [], '{}'))).toMatch(/is not a snapshot$/)
  })
})

describe('SQL file for wrangler d1 execute', () => {
  it('writes literals SQLite reads back', () => {
    expect(sqlLiteral(null)).toBe('NULL')
    expect(sqlLiteral(42)).toBe('42')
    expect(sqlLiteral("it's")).toBe("'it''s'")
    expect(sqlLiteral('a\0b')).toBe("CAST(X'610062' AS TEXT)")
  })

  it('brings events into a relay that already holds some, and applying it twice changes nothing', async () => {
    const target = relay({ MAX_EVENT_AGE_DAYS: '0' })
    const { sk, pk } = key()
    const held = observation(sk, pk, OLD)
    const v1 = dataset(sk, 'Aire v1', OLD)
    for (const event of [held, v1]) expect((await target.publish(event)).ok).toBe(true)

    const fresh = observation(sk, pk, OLD + 1)
    const v2 = dataset(sk, 'Aire v2', OLD + 10) // beats the stored version (DATA-3)
    const v0 = dataset(sk, 'Aire v0', OLD - 10) // loses against v2
    const removal = deletion(sk, [['e', held.id]], OLD + 20)
    const sql = sqlFileDb()
    const file = new Store(sql.db)
    const text = sql.toSql([held, fresh, v2, v0, removal].flatMap((e) => file.importStatements(e, NOW)))

    const state = () => ({
      events: target.count('SELECT COUNT(*) AS n FROM events'),
      tags: target.count('SELECT COUNT(*) AS n FROM tags'),
    })
    target.exec(text)
    const after = state()
    target.exec(text)
    expect(state()).toEqual(after)

    const present = async (e: NostrEvent) => target.store.exists(e.id)
    expect(await present(held)).toBe(false) // removed by the author's kind 5
    expect(await present(fresh)).toBe(true)
    expect(await present(removal)).toBe(true)
    expect(await present(v2)).toBe(true)
    expect(await present(v1)).toBe(false)
    expect(await present(v0)).toBe(false)
    for (const e of [held, v1, v0]) expect(target.count(`SELECT COUNT(*) AS n FROM tags WHERE event_id = '${e.id}'`)).toBe(0)
    expect(target.count(`SELECT COUNT(*) AS n FROM tags WHERE event_id = '${fresh.id}'`)).toBe(4) // a and three g
    expect((await target.store.query({ tags: { d: ['air-quality'] } }, NOW)).map((e) => e.id)).toEqual([v2.id])
  })
})
