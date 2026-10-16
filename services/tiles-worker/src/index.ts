import { FILES } from './files.js'

// Mirror of each city's basemap (docs/spec/06, "Teselas del mapa"): PMTiles over HTTP byte ranges, open to any
// origin (the app runs from file://, IPFS gateways and several mirrors). One mirror among others, never the only
// source: the file is announced with its hash in `city.tiles` and can be opened from disk.

interface Env {
  ASSETS: Fetcher
}

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Range, If-Match',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, ETag',
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
    const path = new URL(request.url).pathname
    const asset = await env.ASSETS.fetch(new Request(request.url))
    // The assets binding answers without Content-Length; sizes come from the extract.
    const size = FILES[path]?.size
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get('Range') ?? '')
    if (!asset.ok || !range || size === undefined || request.method !== 'GET') {
      const headers = new Headers(asset.headers)
      for (const [k, v] of Object.entries(CORS)) headers.set(k, v)
      headers.set('Accept-Ranges', 'bytes')
      if (asset.ok && size !== undefined) headers.set('Content-Length', String(size))
      return new Response(request.method === 'HEAD' ? null : asset.body, { status: asset.status, headers })
    }
    const start = Number(range[1])
    const end = Math.min(range[2] ? Number(range[2]) : size - 1, size - 1)
    if (start > end) return new Response(null, { status: 416, headers: { ...CORS, 'Content-Range': `bytes */${size}` } })

    // Pass bytes start..end through without buffering the file.
    const { readable, writable } = new FixedLengthStream(end - start + 1)
    const copy = async () => {
      const reader = asset.body!.getReader()
      const writer = writable.getWriter()
      let pos = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const from = Math.max(start - pos, 0)
        const to = Math.min(end + 1 - pos, value.length)
        if (to > from) await writer.write(value.subarray(from, to))
        pos += value.length
        if (pos > end) break
      }
      await reader.cancel().catch(() => {})
      await writer.close()
    }
    void copy()
    return new Response(readable, {
      status: 206,
      headers: {
        ...CORS,
        'Content-Type': 'application/octet-stream',
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        ETag: `"${FILES[path]!.sha256}"`,
        // The name carries the date of the extract: a file never changes.
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    })
  },
} satisfies ExportedHandler<Env>
