import { acceptEvent, isNew, type AcceptDeps, type AcceptResult } from './accept.js'
import { exportDay } from './export.js'
import { filterFromQuery } from './filter.js'
import { relayInfo } from './nip11.js'

// HTTP API of the relay (docs/spec/07, "API HTTP"), apart from the Worker entry so it runs on node:sqlite in tests.

// The app runs from arbitrary origins, `null` (file://) included (docs/spec/07, "API HTTP").
export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
}

export function json(body: unknown, status = 200, contentType = 'application/json'): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': contentType } })
}

export interface HttpDeps extends AcceptDeps {
  /** Hands a new event to the WebSocket subscribers. */
  broadcast: (result: Extract<AcceptResult, { ok: true }>) => void
}

/** Answers the HTTP routes, or null for the ones the Worker serves itself (WebSocket, `/health`). */
export async function handleHttp(request: Request, deps: HttpDeps): Promise<Response | null> {
  const url = new URL(request.url)
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

  if (url.pathname === '/') {
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') return null
    if (request.headers.get('Accept')?.includes('application/nostr+json')) {
      return json(relayInfo(deps.config), 200, 'application/nostr+json')
    }
    return new Response('SmartCity relay. Connect with a Nostr client over WebSocket, or use /v1/events.\n', {
      headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }

  if (url.pathname === '/v1/events' && request.method === 'GET') {
    const filter = filterFromQuery(url.searchParams)
    if (typeof filter === 'string') return json({ ok: false, reason: filter }, 400)
    const events = await deps.store.query(filter, deps.now())
    const body = events.map((e) => JSON.stringify(e) + '\n').join('')
    return new Response(body, { headers: { ...CORS, 'Content-Type': 'application/x-ndjson' } })
  }

  if (url.pathname === '/v1/export' && request.method === 'GET') {
    const result = await exportDay(deps.store, url.searchParams)
    if ('error' in result) return json({ ok: false, reason: result.error }, 400)
    return new Response(result.body, { headers: { ...CORS, 'Content-Type': 'application/x-ndjson' } })
  }

  if (url.pathname === '/v1/events' && request.method === 'POST') {
    let raw: unknown
    try {
      raw = await request.json()
    } catch {
      return json({ ok: false, reason: 'invalid: body is not JSON' }, 400)
    }
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
    const result = await acceptEvent(raw, ip, deps)
    if (!result.ok) return json({ ok: false, reason: result.message }, 400)
    if (isNew(result)) deps.broadcast(result)
    return json({ ok: true, id: result.event.id, ...(result.message ? { message: result.message } : {}) })
  }

  if (url.pathname === '/health') return null
  return json({ ok: false, reason: 'not found' }, 404)
}
