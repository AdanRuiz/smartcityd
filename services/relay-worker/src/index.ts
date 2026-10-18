import { readConfig } from './config.js'
import type { Env } from './env.js'
import type { Broadcast, Counters } from './hub.js'
import { handleHttp, json, type HttpDeps } from './http.js'
import { RateLimiter } from './ratelimit.js'
import { runRetention } from './retention.js'
import { roleBookFor } from './roles.js'
import { Store } from './store.js'

export { Hub } from './hub.js'

// HTTP publications are limited per isolate: best effort (see RateLimiter).
const limiter = new RateLimiter()
const seconds = () => Math.floor(Date.now() / 1000)

function hub(env: Env) {
  return env.HUB.get(env.HUB.idFromName('hub'))
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const broadcast: HttpDeps['broadcast'] = (result) => {
      const message: Broadcast = { event: result.event, status: result.status, rowsWritten: result.rowsWritten }
      ctx.waitUntil(hub(env).fetch('https://hub/broadcast', { method: 'POST', body: JSON.stringify(message) }))
    }
    const response = await handleHttp(request, {
      store: new Store(env.DB),
      config: readConfig(env),
      limiter,
      now: seconds,
      broadcast,
    })
    if (response) return response

    if (new URL(request.url).pathname === '/health') {
      const counters = await (await hub(env).fetch('https://hub/counters')).json<Counters>()
      return json({ ok: true, ...counters })
    }
    // WebSocket upgrade on `/`.
    return hub(env).fetch(request)
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
