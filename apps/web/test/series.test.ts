import type { Reading } from '@smartcity/sdk'
import { describe, expect, it } from 'vitest'
import { MAX_DAYS, bucketSeconds, daysBetween, defaultRange, preferredArchivers, rangeError, seriesOf, sourcesOf } from '../src/series'

const reading = (ts: number, values: Reading['values'], extra: Partial<Reading> = {}): Reading => ({
  id: `e${ts}`,
  pubkey: 'p'.repeat(64),
  ts,
  values,
  q: 'ok',
  dataset: '31481:x:air',
  event: `e${ts}`,
  trust: 'community',
  ...extra,
})

describe('historical series (docs/spec/06, PB-26)', () => {
  it('ranges whole UTC days and refuses empty, inverted or too long ones', () => {
    expect(defaultRange(Date.parse('2026-10-20T15:00:00Z'))).toEqual({ from: '2026-09-21', to: '2026-10-20' })
    expect(daysBetween('2026-10-01', '2026-10-01')).toBe(1)
    expect(daysBetween('2026-09-30', '2026-10-02')).toBe(3)
    expect(rangeError('2026-10-01', '2026-10-31')).toBeNull()
    expect(rangeError('', '2026-10-01')).toContain('Elige')
    expect(rangeError('2026-10-02', '2026-10-01')).toContain('anterior')
    expect(rangeError('2026-01-01', '2026-12-31')).toContain(String(MAX_DAYS))
    expect(bucketSeconds(3)).toBe(3600)
    expect(bucketSeconds(4)).toBe(86_400)
  })

  it('aggregates a field per bucket and leaves out bad readings, other types and empty buckets', () => {
    const day = Date.parse('2025-10-08T00:00:00Z') / 1000
    const readings = [
      reading(day + 10, { pm25: 10 }),
      reading(day + 500, { pm25: 30 }),
      reading(day + 600, { pm25: 999 }, { q: 'bad' }),
      reading(day + 700, { pm25: 'n/a' }),
      reading(day + 2 * 86_400 + 5, { pm25: 7, no2: 1 }),
    ]
    expect(seriesOf(readings, 'pm25', 86_400)).toEqual([
      { start: day, count: 2, min: 10, max: 30, mean: 20 },
      { start: day + 2 * 86_400, count: 1, min: 7, max: 7, mean: 7 },
    ])
    expect(seriesOf(readings, 'no2', 3600)).toEqual([{ start: day + 2 * 86_400, count: 1, min: 1, max: 1, mean: 1 }])
  })

  it('prefers snapshots of keys with role archiver, and takes anyone when the city names none', () => {
    expect(preferredArchivers([{ pubkey: 'a', roles: ['authority'] }])).toBeUndefined()
    expect(preferredArchivers([{ pubkey: 'a', roles: ['authority'] }, { pubkey: 'b', roles: ['archiver', 'operator'] }])).toEqual(['b'])
  })

  it('lists the sources seen, the busiest first', () => {
    const readings = [reading(1, {}, { source: 's:1' }), reading(2, {}, { source: 's:2' }), reading(3, {}, { source: 's:2' }), reading(4, {})]
    expect(sourcesOf(readings)).toEqual(['s:2', 's:1'])
  })
})
