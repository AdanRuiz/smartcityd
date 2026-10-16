import { describe, expect, it } from 'vitest'
import { canonicalLine, canonicalNdjson, utcDayRange, type SignedEvent } from '../src/index.js'

function event(id: string, createdAt: number): SignedEvent {
  return {
    id: id.repeat(64),
    pubkey: 'b'.repeat(64),
    created_at: createdAt,
    kind: 1480,
    tags: [['c', 'mx-gdl']],
    content: '{"v":1}',
    sig: 'f'.repeat(128),
  }
}

describe('canonical NDJSON (docs/spec/06, "Formato")', () => {
  it('writes the keys in the canonical order, without spaces, whatever the input order', () => {
    const e = event('a', 10)
    const shuffled = { sig: e.sig, content: e.content, tags: e.tags, kind: e.kind, created_at: e.created_at, pubkey: e.pubkey, id: e.id }
    const line = canonicalLine(shuffled)
    expect(line).toBe(canonicalLine(e))
    expect(Object.keys(JSON.parse(line) as object)).toEqual(['id', 'pubkey', 'created_at', 'kind', 'tags', 'content', 'sig'])
    expect(line).not.toMatch(/[\n ]/)
  })

  it('orders by created_at, then id, deduplicates by id, and ends every line in \\n', () => {
    const [a, b, c] = [event('c', 5), event('a', 7), event('b', 5)]
    const text = canonicalNdjson([b!, a!, c!, a!])
    expect(text.split('\n')).toEqual([canonicalLine(c!), canonicalLine(a!), canonicalLine(b!), ''])
    expect(canonicalNdjson([])).toBe('')
  })

  it('turns a UTC day into [from, to) and rejects dates that do not exist', () => {
    expect(utcDayRange('2025-10-09')).toEqual({ from: 1759968000, to: 1760054400 })
    expect(utcDayRange('2026-02-30')).toBeNull()
    expect(utcDayRange('2026-10-9')).toBeNull()
    expect(utcDayRange('yesterday')).toBeNull()
  })
})
