import { createHash } from 'node:crypto'
import { KIND, canonicalNdjson } from '@smartcity/schemas'
import { describe, expect, it } from 'vitest'
import { exportDay } from '../src/export.js'
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
    const result = await exportDay(r.store, params({ c: CITY, day: DAY }), NOW + 61)
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
      const result = await exportDay(r.store, query, NOW + 61, 2)
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
    expect(await exportDay(r.store, params({ c: CITY, day: '2025-10-11' }), NOW)).toEqual({ body: '' })
  })

  it('rejects bad parameters', async () => {
    const { store } = relay()
    const error = async (values: Record<string, string>) => {
      const result = await exportDay(store, params(values), NOW)
      return 'error' in result ? result.error : null
    }
    expect(await error({ day: DAY })).toBe('c must be a city id')
    expect(await error({ c: CITY, day: '2026-02-30' })).toMatch(/^day must be/)
    expect(await error({ c: CITY, day: DAY, cursor: 'abc' })).toBe('invalid cursor')
    expect(await error({ c: CITY, day: DAY, limit: '5' })).toBe('unknown parameter: limit')
    expect(await error({ c: CITY, received_after: 'x' })).toBe('unsupported: received_after')
  })
})
