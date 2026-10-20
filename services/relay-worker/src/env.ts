import type { RelayVars } from './config.js'
import type { Hub } from './hub.js'

export interface Env extends RelayVars {
  DB: D1Database
  HUB: DurableObjectNamespace<Hub>
  /** Attachments (docs/spec/07, optional). Without this binding `/v1/blob` answers 404. */
  BLOBS?: R2Bucket
}
