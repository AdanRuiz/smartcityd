const WINDOW_MS = 60_000

/**
 * Fixed one-minute windows per key. Keys (IPs included) are forgotten when their window ends (PRIV-8).
 * State lives in memory: per Durable Object for WebSocket, per isolate for HTTP, so the HTTP limit is
 * best effort.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>()
  private lastSweep = 0

  constructor(private readonly now: () => number = Date.now) {}

  /** Counts one hit for every key; false if any of them is over its limit. */
  hit(limits: readonly { key: string; max: number }[]): boolean {
    const now = this.now()
    if (now - this.lastSweep >= WINDOW_MS) this.sweep(now)
    let allowed = true
    for (const { key, max } of limits) {
      let window = this.windows.get(key)
      if (!window || now - window.start >= WINDOW_MS) {
        window = { start: now, count: 0 }
        this.windows.set(key, window)
      }
      window.count++
      if (max > 0 && window.count > max) allowed = false
    }
    return allowed
  }

  private sweep(now: number): void {
    for (const [key, window] of this.windows) if (now - window.start >= WINDOW_MS) this.windows.delete(key)
    this.lastSweep = now
  }
}
