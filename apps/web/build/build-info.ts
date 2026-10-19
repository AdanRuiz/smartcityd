import { execFileSync } from 'node:child_process'

/** What the "Acerca de" screen shows of this build (APP-10). */
export interface BuildInfo {
  version: string
  /** Git commit the build was made from, 40 hex characters, or '' if unknown. */
  commit: string
}

// The commit as each mirror's build environment exposes it, when the checkout has no .git (GOAL-3).
const COMMIT_VARS = ['CF_PAGES_COMMIT_SHA', 'COMMIT_REF', 'VERCEL_GIT_COMMIT_SHA'] as const

const COMMIT = /^[0-9a-f]{40}$/

function gitHead(): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return undefined
  }
}

/**
 * APP-10: version and commit, fixed at build time. Same commit, same values, so the build stays reproducible (APP-6).
 * The commit comes from git, else from the mirror's variables; anything that is not a full commit hash is ignored.
 */
export function buildInfo(version: string, env: Record<string, string | undefined> = process.env, git = gitHead): BuildInfo {
  const candidates = [git(), ...COMMIT_VARS.map((name) => env[name])]
  const commit = candidates.map((c) => c?.trim().toLowerCase()).find((c) => c !== undefined && COMMIT.test(c)) ?? ''
  return { version, commit }
}
