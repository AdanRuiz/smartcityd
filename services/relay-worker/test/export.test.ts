import { createHash } from 'node:crypto'
import { KIND, canonicalLine, canonicalNdjson } from '@smartcity/schemas'
import { describe, expect, it } from 'vitest'
import { EXPORT_PAGE, RECEIVED_SETTLE_SECONDS, RECEIVED_START, exportDay, exportEvents } from '../src/export.js'
import type { Store } from '../src/store.js'
import { CITY, G, NOW, airDataset, dataset, deletion, key, observation, relay, sign } from './helpers.js'

// NOW (1_760_000_000) falls on 2025-10-09 UTC, which starts at 1_759_968_000.
const DAY = '2025-10-09'
const DAY_START = 1_759_968_000
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

async function populated() {
  const r = relay()
  const { sk, pk } = key()
  const inDay = [
    observation(sk, pk, NOW),
    observation(sk, pk, NOW + 1),
    observation(sk, pk, NOW - 600),
    observation(sk, pk, DAY_START),
    dataset(sk, 'Calidad del aire', NOW - 300), // c = '*' belongs to every city
  ]
  const outside = [
    observation(sk, pk, DAY_START - 1), // previous day
    sign(sk, KIND.OBSERVATION, [['c', 'mx-mty'], ['a', airDataset(pk)], ...G], {
      v: 1,
      obs: [{ ts: NOW, values: { pm25: 3 } }],
    }),
    observation(sk, pk, NOW + 2, [['expiration', `${NOW + 60}`]]), // expired at export time
    observation(sk, pk, NOW + 4, [['expiration', `${NOW + 30 * 86_400}`]]), // not expired, still not archived (SNAP-16)
  ]
  const deleted = observation(sk, pk, NOW + 3)
  for (const event of [...inDay, ...outside, deleted]) expect((await r.publish(event)).ok).toBe(true)
  expect((await r.publish(deletion(sk, [['e', deleted.id]]))).ok).toBe(true)
  return { r, inDay }
}

const params = (values: Record<string, string>) => new URLSearchParams(values)

describe('GET /v1/export by day (docs/spec/07)', () => {
  it('produces the canonical NDJSON of the day, with the sha256 the archiver computes (test 7)', async () => {
    const { r, inDay } = await populated()
    const result = await exportDay(r.store, params({ c: CITY, day: DAY }))
    if (!('body' in result)) throw new Error(result.error)
    const expected = canonicalNdjson(inDay)
    expect(result.body).toBe(expected)
    expect(sha256(result.body)).toBe(sha256(expected))
    expect(result.body.trimEnd().split('\n')).toHaveLength(inDay.length)
  })

  it('pages with a cursor line; the pages without it, concatenated, are the canonical NDJSON', async () => {
    const { r, inDay } = await populated()
    let body = ''
    let cursor: string | null = null
    let pages = 0
    do {
      const query = params({ c: CITY, day: DAY, ...(cursor ? { cursor } : {}) })
      const result = await exportDay(r.store, query, 2)
      if (!('body' in result)) throw new Error(result.error)
      const lines = result.body.trimEnd().split('\n')
      const last = JSON.parse(lines.at(-1)!) as { cursor?: string }
      cursor = last.cursor ?? null
      body += (cursor ? lines.slice(0, -1) : lines).map((line) => line + '\n').join('')
      pages++
    } while (cursor)
    expect(pages).toBe(3)
    expect(body).toBe(canonicalNdjson(inDay))
  })

  it('returns an empty body for a day without events', async () => {
    const { r } = await populated()
    expect(await exportDay(r.store, params({ c: CITY, day: '2025-10-11' }))).toEqual({ body: '' })
  })

  it('rejects bad parameters', async () => {
    const { store } = relay()
    const error = async (values: Record<string, string>) => {
      const result = await exportDay(store, params(values))
      return 'error' in result ? result.error : null
    }
    expect(await error({ day: DAY })).toBe('c must be a city id')
    expect(await error({ c: CITY, day: '2026-02-30' })).toMatch(/^day must be/)
    expect(await error({ c: CITY, day: DAY, cursor: 'abc' })).toBe('invalid cursor')
    expect(await error({ c: CITY, day: DAY, limit: '5' })).toBe('unknown parameter: limit')
  })
})

describe('GET /v1/export by order of receipt (docs/spec/07, SNAP-8)', () => {
  const LATER = NOW + RECEIVED_SETTLE_SECONDS

  /** Follows `received_after` pages from `start` to the end; the events and the cursor to ask next time. */
  async function follow(store: Store, now: number, start = RECEIVED_START, page = EXPORT_PAGE) {
    let cursor = start
    let body = ''
    for (let pages = 0; ; pages++) {
      const result = await exportEvents(store, params({ c: CITY, received_after: cursor }), now, page)
      if (!('body' in result)) throw new Error(result.error)
      const lines = result.body.trimEnd().split('\n')
      const last = JSON.parse(lines.at(-1)!) as { cursor: string }
      body += lines.slice(0, -1).map((line) => line + '\n').join('')
      cursor = last.cursor
      if (lines.length - 1 < page) return { body, cursor, pages: pages + 1 }
    }
  }
  const ids = (body: string) => body.trimEnd().split('\n').filter(Boolean).map((line) => (JSON.parse(line) as { id: string }).id)

  it('returns a late event (created 10 days ago) without asking for its day (test 11)', async () => {
    const { r } = await populated()
    const { cursor } = await follow(r.store, LATER)
    const { sk, pk } = key()
    const late = observation(sk, pk, NOW - 10 * 86_400)
    expect((await relay().publish(late)).ok).toBe(true) // within MAX_EVENT_AGE_DAYS
    await r.store.save(late, LATER) // received after the cursor was handed out

    // Not yet: received in the current second, still settling.
    expect(await follow(r.store, LATER, cursor)).toEqual({ body: '', cursor, pages: 1 })
    const next = await follow(r.store, LATER + RECEIVED_SETTLE_SECONDS, cursor)
    expect(next.body).toBe(canonicalNdjson([late]))
    expect(next.cursor).not.toBe(cursor)
  })

  it('gives the events in order of receipt, in pages, with the same set as the day export', async () => {
    const { store } = relay()
    const { sk, pk } = key()
    const t = NOW - 3600
    const first = observation(sk, pk, NOW)
    const second = observation(sk, pk, NOW - 5 * 86_400) // older, but received later
    const third = dataset(sk, 'Calidad del aire', NOW - 300) // c = '*'
    const sameSecond = [observation(sk, pk, NOW + 1), observation(sk, pk, NOW + 2)]
    const leftOut = [
      sign(sk, KIND.OBSERVATION, [['c', 'mx-mty'], ['a', airDataset(pk)], ...G], { v: 1, obs: [{ ts: NOW, values: { pm25: 3 } }] }),
      observation(sk, pk, NOW + 4, [['expiration', `${NOW + 30 * 86_400}`]]),
    ]
    await store.save(first, t)
    await store.save(leftOut[0]!, t + 1)
    await store.save(second, t + 2)
    await store.save(third, t + 3)
    await store.save(leftOut[1]!, t + 4)
    for (const event of sameSecond) await store.save(event, t + 5)

    const whole = await follow(store, LATER)
    const tied = [...sameSecond].sort((a, b) => (a.id < b.id ? -1 : 1))
    expect(ids(whole.body)).toEqual([first.id, second.id, third.id, ...tied.map((e) => e.id)])
    expect(whole.body.trimEnd().split('\n').every((line, i) => line === canonicalLine([first, second, third, ...tied][i]!))).toBe(true)

    const paged = await follow(store, LATER, RECEIVED_START, 2)
    expect(paged.body).toBe(whole.body)
    expect(paged.pages).toBe(3)
    expect(paged.cursor).toBe(whole.cursor)

    // Nothing new: an empty page that gives back the same cursor.
    expect(await follow(store, LATER, whole.cursor)).toEqual({ body: '', cursor: whole.cursor, pages: 1 })
  })

  it('leaves out events received in the last seconds until they settle', async () => {
    const { store } = relay()
    const { sk, pk } = key()
    const old = observation(sk, pk, NOW - 60)
    const recent = observation(sk, pk, NOW)
    await store.save(old, NOW - RECEIVED_SETTLE_SECONDS)
    await store.save(recent, NOW - RECEIVED_SETTLE_SECONDS + 1)
    const now = await follow(store, NOW)
    expect(ids(now.body)).toEqual([old.id])
    expect(ids((await follow(store, NOW + 1, now.cursor)).body)).toEqual([recent.id])
  })

  it('covers every day of the city with what the day export gives for each', async () => {
    const { r, inDay } = await populated()
    const { body } = await follow(r.store, LATER)
    const previous = await exportDay(r.store, params({ c: CITY, day: '2025-10-08' }))
    if (!('body' in previous)) throw new Error(previous.error)
    expect(new Set(ids(body))).toEqual(new Set([...inDay.map((e) => e.id), ...ids(previous.body)]))
    expect(ids(previous.body)).toHaveLength(1)
  })

  it('rejects bad parameters', async () => {
    const { store } = relay()
    const error = async (values: Record<string, string>) => {
      const result = await exportEvents(store, params(values), LATER)
      return 'error' in result ? result.error : null
    }
    expect(await error({ received_after: RECEIVED_START })).toBe('c must be a city id')
    expect(await error({ c: CITY, received_after: '' })).toBe('invalid cursor')
    expect(await error({ c: CITY, received_after: 'x' })).toBe('invalid cursor')
    expect(await error({ c: CITY, received_after: RECEIVED_START, day: DAY })).toBe(
      'unknown parameter with received_after: day',
    )
    expect(await error({ c: CITY, received_after: RECEIVED_START, cursor: '1.' + 'a'.repeat(64) })).toBe(
      'unknown parameter with received_after: cursor',
    )
  })
})
