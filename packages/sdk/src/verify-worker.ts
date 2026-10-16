// Web Worker entry for `workerVerifier` (SDK-5). Load it only as a worker: it takes over `onmessage`.
import { verifyEvent } from 'nostr-tools/pure'
import type { NostrEvent } from './event.js'

const scope = globalThis as unknown as {
  onmessage: ((ev: { data: { n: number; event: NostrEvent } }) => void) | null
  postMessage(message: unknown): void
}

scope.onmessage = ({ data: { n, event } }) => {
  let ok = false
  try {
    ok = verifyEvent(event)
  } catch {
    // malformed: not valid
  }
  scope.postMessage({ n, ok })
}
