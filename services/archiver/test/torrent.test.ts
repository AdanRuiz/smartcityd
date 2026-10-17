import { createHash } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KIND, canonicalLine, validateEvent, type SignedEvent } from '@smartcity/schemas'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { describe, expect, it } from 'vitest'
import { GRACE_SECONDS } from '../src/daily.js'
import { runSnapshot } from '../src/snapshot.js'
import { DEFAULT_TRACKERS, bencode, createTorrent, pieceLength, seedUrl } from '../src/torrent.js'

const sha1 = (data: Uint8Array) => createHash('sha1').update(data).digest()

/** Minimal bdecode for the tests: returns the value and, for the `info` dictionary, its raw bytes. */
function bdecode(buf: Buffer, at = 0): { value: unknown; end: number; info?: Buffer } {
  const c = String.fromCharCode(buf[at]!)
  if (c === 'i') {
    const end = buf.indexOf('e', at)
    return { value: Number(buf.subarray(at + 1, end).toString()), end: end + 1 }
  }
  if (c === 'l') {
    const list: unknown[] = []
    let p = at + 1
    while (buf[p] !== 0x65) {
      const r = bdecode(buf, p)
      list.push(r.value)
      p = r.end
    }
    return { value: list, end: p + 1 }
  }
  if (c === 'd') {
    const dict: Record<string, unknown> = {}
    let info: Buffer | undefined
    let p = at + 1
    while (buf[p] !== 0x65) {
      const k = bdecode(buf, p)
      const v = bdecode(buf, k.end)
      const key = (k.value as Buffer).toString()
      dict[key] = v.value
      if (key === 'info') info = buf.subarray(k.end, v.end)
      p = v.end
    }
    return { value: dict, end: p + 1, info }
  }
  const colon = buf.indexOf(':', at)
  const len = Number(buf.subarray(at, colon).toString())
  return { value: buf.subarray(colon + 1, colon + 1 + len), end: colon + 1 + len }
}

describe('torrent (DIST-1, DIST-3)', () => {
  it('bencodes with sorted keys', () => {
    expect(bencode({ b: 1, a: ['x', 2] }).toString()).toBe('d1:al1:xi2ee1:bi1ee')
    expect(bencode('é').toString('hex')).toBe(Buffer.from('2:é').toString('hex'))
  })

  it('picks a power-of-two piece length that keeps the piece count small', () => {
    expect(pieceLength(1000)).toBe(16 * 1024)
    expect(pieceLength(100 * 1024 * 1024)).toBe(128 * 1024)
    expect(pieceLength(100 * 1024 ** 3)).toBe(4 * 1024 * 1024)
  })

  it('builds a .torrent whose pieces, info hash and magnet match the file', () => {
    const file = new Uint8Array(40_000).map((_, i) => i % 251)
    const url = 'https://mirror.example/sc/sc_mx-gdl_2025-10-09.ndjson.gz'
    const t = createTorrent(file, { name: 'sc_mx-gdl_2025-10-09.ndjson.gz', webSeeds: [url] })
    const decoded = bdecode(Buffer.from(t.bytes))
    const meta = decoded.value as Record<string, unknown>
    const info = meta.info as Record<string, unknown>
    expect(info.length).toBe(40_000)
    expect(info['piece length']).toBe(16 * 1024)
    const pieces = info.pieces as Buffer
    expect(pieces.length).toBe(3 * 20)
    expect(pieces.subarray(20, 40).equals(sha1(file.subarray(16 * 1024, 32 * 1024)))).toBe(true)
    expect(createHash('sha1').update(decoded.info!).digest('hex')).toBe(t.infoHash)
    expect((meta['url-list'] as Buffer[]).map(String)).toEqual([url])
    expect((meta['announce-list'] as Buffer[][]).map(([b]) => String(b))).toEqual(DEFAULT_TRACKERS)
    expect(meta['creation date']).toBeUndefined() // same bytes for every archivist
    expect(t.magnet).toContain(`xt=urn:btih:${t.infoHash}`)
    expect(t.magnet).toContain(`ws=${encodeURIComponent(url)}`)
    expect(t.magnet).toContain(`tr=${encodeURIComponent(DEFAULT_TRACKERS[0]!)}`)
  })

  it('works with no trackers (DHT and web seeds only) and rejects non-HTTP web seeds', () => {
    const t = createTorrent(new Uint8Array(10), { name: 'a', trackers: [] })
    expect(t.magnet).not.toContain('tr=')
    expect(() => createTorrent(new Uint8Array(10), { name: 'a', webSeeds: ['ipfs://x'] })).toThrow(/web seed/)
    expect(seedUrl('https://h.example/dir/', 'a b.gz')).toBe('https://h.example/dir/a%20b.gz')
  })
})

describe('archiver snapshot with distribution (DIST-1 to DIST-3)', () => {
  it('writes the .torrent and puts magnet and urls in the event to sign', async () => {
    const FROM = 1_759_968_000
    const sk = generateSecretKey()
    const pk = getPublicKey(sk)
    const obs = finalizeEvent(
      {
        kind: KIND.OBSERVATION,
        created_at: FROM + 10,
        tags: [['c', 'mx-gdl'], ['a', `${KIND.DATASET}:${pk}:aire`], ['g', '9ewm'], ['g', '9ewmq'], ['g', '9ewmqx']],
        content: JSON.stringify({ v: 1, obs: [{ ts: FROM + 10, values: { pm25: 9 } }] }),
      },
      sk,
    ) as SignedEvent
    const fetch = async (url: string) =>
      new Response(new URL(url).pathname === '/v1/export' ? canonicalLine(obs) + '\n' : '')
    const out = await mkdtemp(join(tmpdir(), 'archiver-'))
    const result = await runSnapshot(
      { city: 'mx-gdl', day: '2025-10-09', relays: ['wss://a.example'], out, webSeeds: ['https://mirror.example/sc'] },
      { fetch, now: FROM + 86_400 + GRACE_SECONDS, log: () => {} },
    )
    const torrent = await readFile(result.files.torrent)
    const event = JSON.parse(await readFile(result.files.event, 'utf8')) as SignedEvent
    const content = JSON.parse(event.content) as { magnet: string; urls: string[] }
    expect(content.urls).toEqual(['https://mirror.example/sc/sc_mx-gdl_2025-10-09.ndjson.gz'])
    expect(content.magnet).toMatch(/^magnet:\?xt=urn:btih:[0-9a-f]{40}&/)
    expect(content.magnet).toContain(`ws=${encodeURIComponent(content.urls[0]!)}`)
    expect(torrent.length).toBeGreaterThan(0)
    expect(validateEvent(event).ok).toBe(true)
  })
})
