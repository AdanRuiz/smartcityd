import { getPow } from 'nostr-tools/nip13'
import { getEventHash } from 'nostr-tools/pure'
import type { EventTemplate } from './event.js'
import { setTimer } from './runtime.js'
import type { WorkerLike } from './verify.js'

export { getPow }

/** Hashes tried between pauses, so a cancel request (and, inline, the rest of the program) gets a turn. */
export const MINE_CHUNK = 20_000

export class PowCancelled extends Error {
  constructor() {
    super('proof of work cancelled')
    this.name = 'PowCancelled'
  }
}

/** The part of an `AbortSignal` this module uses. */
export interface CancelSignal {
  readonly aborted: boolean
  addEventListener(type: 'abort', listener: () => void): void
}

/**
 * NIP-13 proof of work (SDK-8, SPAM-1): finds a `nonce` tag that gives the event id at least `bits` leading zero
 * bits. Mining depends on the author, so it takes the pubkey of whoever will sign. Returns the template to sign.
 */
export interface Miner {
  mine(template: EventTemplate, pubkey: string, bits: number, signal?: CancelSignal): Promise<EventTemplate>
  close?(): void
}

/**
 * One step of the search, shared by the inline miner and the worker. Returns the template when found; null to
 * continue from `start + MINE_CHUNK`.
 */
export function mineChunk(template: EventTemplate, pubkey: string, bits: number, start: number): EventTemplate | null {
  const base = template.tags.filter((t) => t[0] !== 'nonce')
  const tag = ['nonce', '', String(bits)]
  const candidate = { ...template, pubkey, tags: [...base, tag] }
  for (let n = start; n < start + MINE_CHUNK; n++) {
    tag[1] = String(n)
    if (getPow(getEventHash(candidate)) >= bits) return { ...template, tags: [...base, [...tag]] }
  }
  return null
}

/** Mines on the calling thread, pausing between chunks. Default outside the browser. */
export const inlineMiner: Miner = {
  mine: async (template, pubkey, bits, signal) => {
    for (let start = 0; ; start += MINE_CHUNK) {
      if (signal?.aborted) throw new PowCancelled()
      const found = mineChunk(template, pubkey, bits, start)
      if (found) return found
      await new Promise((resolve) => setTimer(() => resolve(undefined), 0))
    }
  },
}

/**
 * SDK-8: mining in a Web Worker running `@smartcity/sdk/pow-worker`, so the interface stays responsive. Cancelling
 * (with `signal`) stops the search in the worker.
 */
export function workerMiner(worker: WorkerLike): Miner {
  const waiting = new Map<number, { resolve(t: EventTemplate): void; reject(e: Error): void }>()
  let next = 0
  worker.addEventListener('message', ({ data }) => {
    const { n, template } = data as { n: number; template: EventTemplate | null }
    const w = waiting.get(n)
    waiting.delete(n)
    if (!w) return
    if (template) w.resolve(template)
    else w.reject(new PowCancelled())
  })
  return {
    mine: (template, pubkey, bits, signal) =>
      new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new PowCancelled())
        const n = next++
        waiting.set(n, { resolve, reject })
        signal?.addEventListener('abort', () => worker.postMessage({ cancel: n }))
        worker.postMessage({ n, template, pubkey, bits })
      }),
    close: () => worker.terminate(),
  }
}
