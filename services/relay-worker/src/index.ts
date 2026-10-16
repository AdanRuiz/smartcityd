import { acceptEvent, isNew } from './accept.js'
import { readConfig } from './config.js'
import type { Env } from './env.js'
import { exportDay } from './export.js'
import { filterFromQuery } from './filter.js'
import type { Broadcast, Counters } from './hub.js'
import { relayInfo } from './nip11.js'
import { RateLimiter } from './ratelimit.js'
import { runRetention } from './retention.js'
import { roleBookFor } from './roles.js'
import { Store } from './store.js'

export { Hub } from './hub.js'

// The app runs from arbitrary origins, `null` (file://) included (docs/spec/07, "API HTTP").
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
}

// HTTP publications are limited per isolate: best effort (see RateLimiter).
const limiter = new RateLimiter()
const seconds = () => Math.floor(Date.now() / 1000)

function json(body: unknown, status = 200, contentType = 'application/json'): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': contentType } })
}

function hub(env: Env) {
  return env.HUB.get(env.HUB.idFromName('hub'))
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

    if (url.pathname === '/') {
      if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') return hub(env).fetch(request)
      if (request.headers.get('Accept')?.includes('application/nostr+json')) {
        return json(relayInfo(readConfig(env)), 200, 'application/nostr+json')
      }
      return new Response('SmartCity relay. Connect with a Nostr client over WebSocket, or use /v1/events.\n', {
        headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' },
      })
    }

    if (url.pathname === '/v1/events' && request.method === 'GET') {
      const filter = filterFromQuery(url.searchParams)
      if (typeof filter === 'string') return json({ ok: false, reason: filter }, 400)
      const events = await new Store(env.DB).query(filter, seconds())
      const body = events.map((e) => JSON.stringify(e) + '\n').join('')
      return new Response(body, { headers: { ...CORS, 'Content-Type': 'application/x-ndjson' } })
    }

    if (url.pathname === '/v1/export' && request.method === 'GET') {
      const result = await exportDay(new Store(env.DB), url.searchParams, seconds())
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
      const deps = { store: new Store(env.DB), config: readConfig(env), limiter, now: seconds }
      const result = await acceptEvent(raw, ip, deps)
      if (!result.ok) return json({ ok: false, reason: result.message }, 400)
      if (isNew(result)) {
        const message: Broadcast = { event: result.event, status: result.status, rowsWritten: result.rowsWritten }
        ctx.waitUntil(hub(env).fetch('https://hub/broadcast', { method: 'POST', body: JSON.stringify(message) }))
      }
      return json({ ok: true, id: result.event.id, ...(result.message ? { message: result.message } : {}) })
    }

    if (url.pathname === '/health') {
      const counters = await (await hub(env).fetch('https://hub/counters')).json<Counters>()
      return json({ ok: true, ...counters })
    }

    return json({ ok: false, reason: 'not found' }, 404)
  },

  // Cron Trigger of wrangler.toml: retention (docs/spec/07, "Retención", RELAY-4).
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const config = readConfig(env)
    const deps = {
      store: new Store(env.DB),
      config,
      roles: roleBookFor(config.trustAnchors),
      fetch: (url: string, init: { method: 'HEAD' }) => fetch(url, init),
      now: seconds(),
    }
    ctx.waitUntil(runRetention(deps).then((report) => console.log(JSON.stringify({ retention: report }))))
  },
} satisfies ExportedHandler<Env>
