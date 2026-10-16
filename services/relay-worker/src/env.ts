import type { RelayVars } from './config.js'
import type { Hub } from './hub.js'

export interface Env extends RelayVars {
  DB: D1Database
  HUB: DurableObjectNamespace<Hub>
}
