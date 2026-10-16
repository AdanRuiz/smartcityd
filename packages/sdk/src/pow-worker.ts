// Web Worker entry for `workerMiner` (SDK-8). Load it only as a worker: it takes over `onmessage`.
import type { EventTemplate } from './event.js'
import { MINE_CHUNK, mineChunk } from './pow.js'

type Job = { n: number; template: EventTemplate; pubkey: string; bits: number }
type Message = Job | { cancel: number }

const scope = globalThis as unknown as {
  onmessage: ((ev: { data: Message }) => void) | null
  postMessage(message: unknown): void
  setTimeout(fn: () => void, ms: number): unknown
}

const cancelled = new Set<number>()

function run(job: Job, start: number): void {
  if (cancelled.delete(job.n)) return scope.postMessage({ n: job.n, template: null })
  const found = mineChunk(job.template, job.pubkey, job.bits, start)
  if (found) return scope.postMessage({ n: job.n, template: found })
  // Yield so a cancel message can arrive.
  scope.setTimeout(() => run(job, start + MINE_CHUNK), 0)
}

scope.onmessage = ({ data }) => {
  if ('cancel' in data) cancelled.add(data.cancel)
  else run(data, 0)
}
