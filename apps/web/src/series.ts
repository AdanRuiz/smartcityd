// Historical series of a dataset field (docs/spec/06, "Consulta de historial en la app"; PB-26).
import type { Reading } from '@smartcity/sdk'

const DAY_MS = 86_400_000

/** Longest range one query reads: every day of it may be a whole daily file to download and verify (SNAP-6). */
export const MAX_DAYS = 92

export interface Bucket {
  /** Start of the bucket, seconds. */
  start: number
  count: number
  min: number
  max: number
  mean: number
}

/** UTC day `YYYY-MM-DD` of a time in milliseconds. */
export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

/** The last 30 days, today included. */
export function defaultRange(nowMs: number): { from: string; to: string } {
  return { from: utcDay(nowMs - 29 * DAY_MS), to: utcDay(nowMs) }
}

/** Days of a range, both ends included; NaN when a day is not `YYYY-MM-DD`. */
export function daysBetween(from: string, to: string): number {
  const valid = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d)
  if (!valid(from) || !valid(to)) return NaN
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1
}

/** Why a range cannot be read, or null. */
export function rangeError(from: string, to: string): string | null {
  const days = daysBetween(from, to)
  if (Number.isNaN(days)) return 'Elige el día inicial y el final.'
  if (days < 1) return 'El día final es anterior al inicial.'
  if (days > MAX_DAYS) return `Como máximo ${MAX_DAYS} días por consulta.`
  return null
}

/** Hourly buckets for up to 3 days, daily ones beyond. Seconds. */
export const bucketSeconds = (days: number): number => (days <= 3 ? 3600 : 86_400)

/**
 * Mean, minimum and maximum of a numeric field per bucket, oldest first. Readings marked `bad` (docs/spec/03) and
 * non-numeric values do not count; empty buckets are left out.
 */
export function seriesOf(readings: readonly Reading[], field: string, bucket: number): Bucket[] {
  const byStart = new Map<number, { count: number; sum: number; min: number; max: number }>()
  for (const r of readings) {
    const value = r.values[field]
    if (r.q === 'bad' || typeof value !== 'number' || !Number.isFinite(value)) continue
    const start = Math.floor(r.ts / bucket) * bucket
    const b = byStart.get(start)
    if (b) {
      b.count++
      b.sum += value
      b.min = Math.min(b.min, value)
      b.max = Math.max(b.max, value)
    } else byStart.set(start, { count: 1, sum: value, min: value, max: value })
  }
  return [...byStart.entries()]
    .sort(([a], [b]) => a - b)
    .map(([start, b]) => ({ start, count: b.count, min: b.min, max: b.max, mean: b.sum / b.count }))
}

/** docs/spec/06, "Varios archivistas": snapshots of keys with role `archiver` when the city names any; else anyone's. */
export function preferredArchivers(attested: readonly { pubkey: string; roles: readonly string[] }[]): string[] | undefined {
  const keys = attested.filter((a) => a.roles.includes('archiver')).map((a) => a.pubkey)
  return keys.length > 0 ? keys : undefined
}

/** Sources seen in the readings, by number of readings. */
export function sourcesOf(readings: readonly Reading[]): string[] {
  const counts = new Map<string, number>()
  for (const r of readings) if (r.source) counts.set(r.source, (counts.get(r.source) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([s]) => s)
}
