import { KIND } from '@smartcity/schemas'
import { describe, expect, it } from 'vitest'
import { readConfig, type RelayVars } from '../src/config.js'
import { NO_ANCHORS, runRetention, webSeeds } from '../src/retention.js'
import { RoleBook } from '../src/roles.js'
import { CITY, NOW, dataset, deletion, key, observation, relay, roles, sign } from './helpers.js'

// NOW (1_760_000_000) falls on 2025-10-09 UTC; the day under test is ten days earlier, 2025-09-29.
const DAY = 86_400
const DAY_START = 1_759_968_000 - 10 * DAY
const LATER = NOW + 85 * DAY // 2025-09-29 is past RETENTION_DAYS = 90, the day of NOW is not
const FILE = 'sc_mx-gdl_2025-09-29.ndjson.gz'
const URL_GZ = `https://archive.example/${FILE}`
const SIZE = 9320

// Old events are published as by import: no age limit (RELAY-5).
const VARS: RelayVars = { MAX_EVENT_AGE_DAYS: '0', POW_BITS_REPORT: '0' }
const OBSERVATIONS = 'SELECT COUNT(*) AS n FROM events WHERE kind = 1480'

function snapshot(
  sk: Uint8Array,
  count: number,
  extra: { t?: string; urls?: string[]; magnet?: string; size?: number; from?: number; to?: number } = {},
) {
  const x = 'a'.repeat(64)
  return sign(
    sk,
    KIND.SNAPSHOT,
    [['c', CITY], ['t', extra.t ?? 'daily'], ['x', x]],
    {
      v: 1,
      from: extra.from ?? DAY_START,
      to: extra.to ?? DAY_START + DAY,
      count,
      format: 'ndjson+gzip',
      x,
      file: { name: FILE, x: 'b'.repeat(64), size: extra.size ?? SIZE },
      ...(extra.urls ? { urls: extra.urls } : { urls: [URL_GZ] }),
      ...(extra.magnet ? { magnet: extra.magnet } : {}),
      policy: 'none',
    },
    DAY_START + 3 * DAY,
  )
}

/** A web server where each URL answers with a fixed Content-Length (or fails). */
function server(files: Record<string, number | 'down'>) {
  const asked: string[] = []
  const fetch = async (url: string, init: { method: 'HEAD' }) => {
    expect(init.method).toBe('HEAD')
    asked.push(url)
    const size = files[url]
    if (size === 'down') throw new Error('network down')
    if (size === undefined) return new Response(null, { status: 404 })
    return new Response(null, { status: 200, headers: { 'Content-Length': String(size) } })
  }
  return { fetch, asked }
}

/**
 * A relay with one day of events past retention. By default it has a trust anchor that gives the publishing key
 * role `archiver`; `anchors: false` leaves TRUST_ANCHORS empty, `archiver: false` keeps the anchor but not the role.
 */
async function setup(vars: RelayVars = {}, { anchors = true, archiver = true } = {}) {
  const anchor = key()
  const all = { ...VARS, ...(anchors ? { TRUST_ANCHORS: anchor.pk } : {}), ...vars }
  const r = relay(all)
  const { sk, pk } = key()
  const day = [observation(sk, pk, DAY_START + 100), observation(sk, pk, DAY_START + 200), observation(sk, pk, DAY_START)]
  const later = observation(sk, pk, NOW) // still inside retention at LATER
  const other = dataset(sk, 'Calidad del aire', DAY_START + 50) // addressable with c = '*'
  for (const event of [...day, later, other]) expect((await r.publish(event)).ok).toBe(true)
  if (anchors && archiver) expect((await r.publish(roles(anchor.sk, [[pk, 'archiver']]))).ok).toBe(true)
  const run = (files: Record<string, number | 'down'>, now = LATER) => {
    const config = readConfig(all)
    const web = server(files)
    return runRetention({ store: r.store, config, roles: new RoleBook(config.trustAnchors), fetch: web.fetch, now }).then(
      (report) => ({ report, asked: web.asked }),
    )
  }
  return { r, sk, pk, anchor, day, run }
}

describe('retention (docs/spec/07, "Retención", RELAY-4)', () => {
  it('purges a day whose snapshot is obtainable and counts every stored event (test 12, positive case)', async () => {
    const { r, sk, run } = await setup()
    // count covers the 3 observations and the city-wide dataset the export includes.
    expect((await r.publish(snapshot(sk, 4))).ok).toBe(true)
    const { report, asked } = await run({ [URL_GZ]: SIZE })
    expect(asked).toEqual([URL_GZ])
    expect(report.purgedDays).toEqual([{ city: CITY, day: DAY_START }])
    expect(r.count(OBSERVATIONS)).toBe(1) // the event of ten days later stays
    // Addressables, snapshots and their tags are never purged by age.
    expect(r.count(`SELECT COUNT(*) AS n FROM events WHERE kind IN (${KIND.DATASET}, ${KIND.SNAPSHOT})`)).toBe(2)
    expect(r.count('SELECT COUNT(*) AS n FROM tags WHERE kind = 1480')).toBe(4) // 1 observation × 4 indexed tags
  })

  it('keeps a day without a covering snapshot', async () => {
    const { r, sk, run } = await setup()
    expect((await r.publish(snapshot(sk, 4, { from: DAY_START + DAY, to: DAY_START + 2 * DAY }))).ok).toBe(true)
    const { report } = await run({ [URL_GZ]: SIZE })
    expect(report.purgedDays).toEqual([])
    expect(report.keptDays).toEqual([{ city: CITY, day: DAY_START, reason: 'no snapshot from an archiver covers the day' }])
    expect(r.count(OBSERVATIONS)).toBe(4)
  })

  it('keeps a day whose file is not obtainable or has another size (test 12)', async () => {
    const cases: Record<string, number | 'down'>[] = [{}, { [URL_GZ]: SIZE + 1 }, { [URL_GZ]: 'down' }]
    for (const files of cases) {
      const { r, sk, run } = await setup()
      expect((await r.publish(snapshot(sk, 4))).ok).toBe(true)
      const { report } = await run(files)
      expect(report.keptDays.map((d) => d.reason)).toEqual(['no snapshot file is obtainable'])
      expect(r.count(OBSERVATIONS)).toBe(4)
    }
  })

  it('keeps a day whose count is below what is stored, until an obtainable addendum makes up for it (test 12)', async () => {
    const { r, sk, run } = await setup()
    expect((await r.publish(snapshot(sk, 3))).ok).toBe(true)
    let { report } = await run({ [URL_GZ]: SIZE })
    expect(report.keptDays.map((d) => d.reason)).toEqual(['snapshot count 3 is below the 4 events stored'])
    expect(r.count(OBSERVATIONS)).toBe(4)

    const addendumUrl = 'https://archive.example/sc_mx-gdl_2025-09-29_a1.ndjson.gz'
    expect((await r.publish(snapshot(sk, 1, { t: 'addendum', urls: [addendumUrl], size: 300 }))).ok).toBe(true)
    ;({ report } = await run({ [URL_GZ]: SIZE }))
    expect(report.purgedDays).toEqual([]) // the addendum file is not obtainable: it does not count
    ;({ report } = await run({ [URL_GZ]: SIZE, [addendumUrl]: 300 }))
    expect(report.purgedDays).toEqual([{ city: CITY, day: DAY_START }])
    expect(r.count(OBSERVATIONS)).toBe(1)
  })

  it('finds the file through the web seeds of the magnet (DIST-3)', async () => {
    const { r, sk, run } = await setup()
    const magnet = 'magnet:?xt=urn:btih:abc&ws=https%3A%2F%2Fseed.example%2Fdata%2F&tr=udp%3A%2F%2Ft.example'
    expect((await r.publish(snapshot(sk, 4, { urls: [], magnet }))).ok).toBe(true)
    const { report, asked } = await run({ [`https://seed.example/data/${FILE}`]: SIZE })
    expect(asked).toEqual([`https://seed.example/data/${FILE}`])
    expect(report.purgedDays).toHaveLength(1)
  })

  it('with TRUST_ANCHORS, only counts snapshots of keys with role archiver', async () => {
    const { r, sk, pk, anchor, run } = await setup({}, { archiver: false })
    expect((await r.publish(snapshot(sk, 4))).ok).toBe(true)
    let { report } = await run({ [URL_GZ]: SIZE })
    expect(report.keptDays.map((d) => d.reason)).toEqual(['no snapshot from an archiver covers the day'])

    expect((await r.publish(roles(anchor.sk, [[pk, 'archiver']]))).ok).toBe(true)
    ;({ report } = await run({ [URL_GZ]: SIZE }))
    expect(report.purgedDays).toEqual([{ city: CITY, day: DAY_START }])
  })

  it('without TRUST_ANCHORS, purges nothing by age even with a valid, obtainable and complete snapshot (ADR-20)', async () => {
    const { r, sk, run } = await setup({}, { anchors: false })
    expect((await r.publish(snapshot(sk, 4))).ok).toBe(true)
    const { report, asked } = await run({ [URL_GZ]: SIZE })
    expect(report.ageSkipped).toBe(NO_ANCHORS)
    expect(report.purgedDays).toEqual([])
    expect(report.purgedRows).toBe(0)
    expect(asked).toEqual([]) // no snapshot is even probed
    expect(r.count(OBSERVATIONS)).toBe(4)
  })

  it('without TRUST_ANCHORS, still deletes expired events (NIP-40, ADR-20)', async () => {
    const { r, sk, pk, run } = await setup({}, { anchors: false })
    const expiring = observation(sk, pk, DAY_START + 300, [['expiration', `${NOW + DAY}`]])
    expect((await r.publish(expiring)).ok).toBe(true)
    const { report } = await run({ [URL_GZ]: SIZE })
    expect(report.expiredRows).toBe(5) // the event and its 4 indexed tags
    expect(r.count(`SELECT COUNT(*) AS n FROM events WHERE id = '${expiring.id}'`)).toBe(0)
    expect(r.count(OBSERVATIONS)).toBe(4)
  })

  it('does not purge days inside RETENTION_DAYS, nor anything with RETENTION_DAYS=0', async () => {
    const { r, sk, run } = await setup()
    expect((await r.publish(snapshot(sk, 4))).ok).toBe(true)
    expect((await run({ [URL_GZ]: SIZE }, NOW + 75 * DAY)).report.purgedDays).toEqual([])
    expect(r.count(OBSERVATIONS)).toBe(4)

    const disabled = await setup({ RETENTION_DAYS: '0' })
    expect((await disabled.r.publish(snapshot(disabled.sk, 4))).ok).toBe(true)
    expect((await disabled.run({ [URL_GZ]: SIZE })).report.purgedDays).toEqual([])
    expect(disabled.r.count(OBSERVATIONS)).toBe(4)
  })

  it('never purges deletions, and deletes expired events with their tags', async () => {
    const { r, sk, pk, run } = await setup()
    const expiring = observation(sk, pk, NOW - 1, [['expiration', `${NOW + DAY}`]])
    expect((await r.publish(expiring)).ok).toBe(true)
    expect((await r.publish(deletion(sk, [['e', 'f'.repeat(64)]], DAY_START))).ok).toBe(true)
    const { report } = await run({})
    expect(report.expiredRows).toBe(5) // the event and its 4 indexed tags
    expect(r.count(`SELECT COUNT(*) AS n FROM events WHERE id = '${expiring.id}'`)).toBe(0)
    expect(r.count('SELECT COUNT(*) AS n FROM events WHERE kind = 5')).toBe(1)
  })
})

describe('webSeeds', () => {
  it('reads every ws= of a magnet and appends the file name to directory seeds', () => {
    const magnet = 'magnet:?xt=urn:btih:abc&ws=https%3A%2F%2Fa.example%2Ff.gz&ws=https%3A%2F%2Fb.example%2F'
    expect(webSeeds(magnet, 'f.gz')).toEqual(['https://a.example/f.gz', 'https://b.example/f.gz'])
    expect(webSeeds('https://not-a-magnet', 'f.gz')).toEqual([])
  })
})
