import { bytesToHex } from 'nostr-tools/utils'
import { SINGLE_FILE, buildIdOf } from './variant'

/** `smartcity.html` as this origin serves it: its bytes, size, sha256 (the hash a `release` announces, DIST-2) and build id. */
export interface SelfCopy {
  bytes: ArrayBuffer
  size: number
  sha256: string
  build: string | null
}

/**
 * APP-10: where to read `smartcity.html` of this build. In `dist/` it sits next to `index.html`, on every mirror and
 * IPFS subpath; in the single file it is the page itself. Null from `file://`: browsers do not let a page read files.
 */
export function selfCopyUrl(href: string, singleFile: boolean): string | null {
  const url = new URL(href)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  url.hash = ''
  return singleFile ? url.href : new URL(`./${SINGLE_FILE}`, url).href
}

/** Downloads `smartcity.html` and hashes it. Throws if it cannot be read or the browser has no Web Crypto. */
export async function loadSelfCopy(
  url: string,
  fetchFn: typeof fetch = fetch,
  // Undefined outside a secure context (a mirror over plain HTTP).
  subtle: SubtleCrypto | null = globalThis.crypto?.subtle ?? null,
): Promise<SelfCopy> {
  if (!subtle) throw new Error('este navegador no calcula sha256 en una página sin HTTPS')
  // no-cache: what this origin serves now, not an old copy in the HTTP cache. It can be a newer deploy than the page
  // that is running: `build` tells them apart.
  const res = await fetchFn(url, { cache: 'no-cache' })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  const bytes = await res.arrayBuffer()
  const digest = await subtle.digest('SHA-256', bytes)
  return {
    bytes,
    size: bytes.byteLength,
    sha256: bytesToHex(new Uint8Array(digest)),
    build: buildIdOf(new TextDecoder().decode(bytes)),
  }
}

/**
 * Whether the downloaded copy is the build that is running. Without an id on either side (development) it cannot be
 * told, and the copy is taken as it is.
 */
export function isSameBuild(copy: Pick<SelfCopy, 'build'>, running: string | null): boolean {
  return running === null || copy.build === running
}
