import { verifyEvent } from 'nostr-tools/pure'
import type { NostrEvent } from './event.js'

/** Checks `id` and `sig` of a received event (DATA-1, SDK-5). */
export interface Verifier {
  verify(event: NostrEvent): Promise<boolean>
  close?(): void
}

/**
 * Verifies on the calling thread. Default outside the browser. It checks a plain copy: nostr-tools remembers a result
 * on the object it verified, and a copy made with spread of a verified event would carry that mark with altered fields.
 */
export const inlineVerifier: Verifier = {
  verify: async (event) => {
    try {
      const { id, pubkey, created_at, kind, tags, content, sig } = event
      return verifyEvent({ id, pubkey, created_at, kind, tags, content, sig })
    } catch {
      return false
    }
  },
}

/** The part of a `Worker` this module uses. */
export interface WorkerLike {
  postMessage(message: unknown): void
  terminate(): void
  addEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void
}

/**
 * SDK-5: verification in a Web Worker, so the browser's main thread stays free. The worker runs
 * `@smartcity/sdk/verify-worker`; with Vite: `new Worker(new URL('@smartcity/sdk/verify-worker', import.meta.url), { type: 'module' })`
 * or `import VerifyWorker from '@smartcity/sdk/verify-worker?worker&inline'`.
 */
export function workerVerifier(worker: WorkerLike): Verifier {
  const waiting = new Map<number, (ok: boolean) => void>()
  let next = 0
  worker.addEventListener('message', ({ data }) => {
    const { n, ok } = data as { n: number; ok: boolean }
    waiting.get(n)?.(ok === true)
    waiting.delete(n)
  })
  return {
    verify: (event) =>
      new Promise((resolve) => {
        const n = next++
        waiting.set(n, resolve)
        worker.postMessage({ n, event })
      }),
    close: () => {
      worker.terminate()
      for (const resolve of waiting.values()) resolve(false)
      waiting.clear()
    },
  }
}
