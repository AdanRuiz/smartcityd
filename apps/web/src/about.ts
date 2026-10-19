/** Name of the single-file variant (APP-4); the same as `SINGLE_FILE` in build/single-file.ts. */
export const SINGLE_FILE = 'smartcity.html'

/** `smartcity.html` of this build: its bytes, size and sha256, the hash that the `release` announces (DIST-2). */
export interface SelfCopy {
  bytes: ArrayBuffer
  size: number
  sha256: string
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

export function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Downloads `smartcity.html` and hashes it. Throws if it cannot be read or the browser has no Web Crypto. */
export async function loadSelfCopy(
  url: string,
  fetchFn: typeof fetch = fetch,
  // Undefined outside a secure context (a mirror over plain HTTP).
  subtle: SubtleCrypto | null = globalThis.crypto?.subtle ?? null,
): Promise<SelfCopy> {
  if (!subtle) throw new Error('este navegador no calcula sha256 en una página sin HTTPS')
  // no-cache: the hash is of what this origin serves now, not of an old copy in the HTTP cache.
  const res = await fetchFn(url, { cache: 'no-cache' })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  const bytes = await res.arrayBuffer()
  return { bytes, size: bytes.byteLength, sha256: hex(await subtle.digest('SHA-256', bytes)) }
}
