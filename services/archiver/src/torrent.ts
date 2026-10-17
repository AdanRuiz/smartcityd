import { createHash } from 'node:crypto'

// BitTorrent v1 metainfo for one file (BEP-3), with web seeds (BEP-19) and its magnet link (BEP-9), for DIST-1 to
// DIST-3. No dependency: bencoding and SHA-1 pieces are a few lines. The torrent has no creation date or creator,
// so two archivists with the same file, trackers and web seeds produce the same bytes; the info hash depends only
// on the file and its name.

/**
 * Public trackers used when none is given. Several, since any of them can disappear (DIST-3); the `wss:` one lets
 * WebTorrent clients in the browser find peers (DIST-5). Without trackers the torrent still works through DHT and
 * its web seeds.
 */
export const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'wss://tracker.openwebtorrent.com',
]

type Bencodable = number | string | Uint8Array | Bencodable[] | { [key: string]: Bencodable }

/** Bencoding (BEP-3): dictionary keys sorted by their raw bytes. */
export function bencode(value: Bencodable): Buffer {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`bencode: not an integer: ${value}`)
    return Buffer.from(`i${value}e`)
  }
  if (typeof value === 'string' || value instanceof Uint8Array) {
    const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value)
    return Buffer.concat([Buffer.from(`${bytes.length}:`), bytes])
  }
  if (Array.isArray(value)) return Buffer.concat([Buffer.from('l'), ...value.map(bencode), Buffer.from('e')])
  const keys = Object.keys(value).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
  return Buffer.concat([Buffer.from('d'), ...keys.flatMap((k) => [bencode(k), bencode(value[k]!)]), Buffer.from('e')])
}

/** Power of two between 16 KiB and 4 MiB giving at most about 1500 pieces. */
export function pieceLength(size: number): number {
  let length = 16 * 1024
  while (length < 4 * 1024 * 1024 && Math.ceil(size / length) > 1500) length *= 2
  return length
}

export interface TorrentOptions {
  /** File name inside the torrent, as published (`sc_<city>_<day>.ndjson.gz`). */
  name: string
  trackers?: readonly string[]
  /** Full HTTP(S) URLs of the same file (BEP-19 `url-list`, magnet `ws=`). */
  webSeeds?: readonly string[]
}

export interface Torrent {
  /** `.torrent` file. */
  bytes: Uint8Array
  /** SHA-1 of the bencoded `info`, hex. */
  infoHash: string
  magnet: string
}

export function createTorrent(file: Uint8Array, options: TorrentOptions): Torrent {
  const trackers = [...(options.trackers ?? DEFAULT_TRACKERS)]
  const webSeeds = [...(options.webSeeds ?? [])]
  for (const url of webSeeds) {
    if (!/^https?:\/\//.test(url)) throw new Error(`a web seed must be an http(s) URL: ${url}`)
  }
  const length = pieceLength(file.length)
  const pieces: Buffer[] = []
  for (let at = 0; at < file.length; at += length) {
    pieces.push(createHash('sha1').update(file.subarray(at, at + length)).digest())
  }
  const info = { length: file.length, name: options.name, 'piece length': length, pieces: Buffer.concat(pieces) }
  const infoHash = createHash('sha1').update(bencode(info)).digest('hex')

  const meta: Record<string, Bencodable> = { info }
  if (trackers.length > 0) {
    meta.announce = trackers[0]!
    meta['announce-list'] = trackers.map((t) => [t])
  }
  if (webSeeds.length > 0) meta['url-list'] = webSeeds

  const params = [`xt=urn:btih:${infoHash}`, `dn=${encodeURIComponent(options.name)}`, `xl=${file.length}`]
  for (const t of trackers) params.push(`tr=${encodeURIComponent(t)}`)
  for (const w of webSeeds) params.push(`ws=${encodeURIComponent(w)}`)
  return { bytes: new Uint8Array(bencode(meta)), infoHash, magnet: `magnet:?${params.join('&')}` }
}

/** URL of a published file on a web seed given as a base: `https://host/dir` + `/name`. */
export function seedUrl(base: string, name: string): string {
  return `${base.replace(/\/+$/, '')}/${encodeURIComponent(name)}`
}
