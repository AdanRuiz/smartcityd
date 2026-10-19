import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** What the "Acerca de" screen shows of this build (APP-10). */
export interface BuildInfo {
  version: string
  /** Git commit the build was made from, 40 or 64 hex characters (SHA-1 or SHA-256 repository), or '' if unknown. */
  commit: string
  /**
   * The code that goes into the bundle (apps/web and packages/) had uncommitted changes, new files not yet added to
   * git included: the commit does not describe the code. Files ignored by .gitignore, such as dist/, do not count.
   */
  dirty: boolean
}

/** Runs git in apps/web and returns its output, or undefined if git is missing or fails. */
export type Git = (args: string[]) => string | undefined

/** Reads build/commit.txt, which `git archive` fills in (export-subst in .gitattributes). */
export type ArchiveCommit = () => string | undefined

// The commit as each mirror's build environment exposes it (GOAL-3).
const COMMIT_VARS = ['CF_PAGES_COMMIT_SHA', 'COMMIT_REF', 'VERCEL_GIT_COMMIT_SHA'] as const

const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

// Where apps/web sits in this repository, as `git rev-parse --show-prefix` prints it from there.
const PREFIX = 'apps/web/'

// What goes into the bundle, relative to apps/web: the app and the workspace packages it imports.
export const BUNDLED_PATHS = ['.', '../../packages'] as const

const appDir = fileURLToPath(new URL('..', import.meta.url))

const runGit: Git = (args) => {
  try {
    return execFileSync('git', args, { cwd: appDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return undefined
  }
}

const readArchiveCommit: ArchiveCommit = () => {
  try {
    return readFileSync(new URL('./commit.txt', import.meta.url), 'utf8')
  } catch {
    return undefined
  }
}

const valid = (c: string | undefined) => {
  const commit = c?.trim().toLowerCase()
  return commit !== undefined && COMMIT.test(commit) ? commit : undefined
}

/**
 * APP-10: version and commit, fixed at build time. The commit is part of the built bytes, so a third party who builds
 * the same commit gets the same hash only if the build learns the same commit (APP-6). In order:
 * 1. `SMARTCITY_COMMIT`, to set it by hand (a tarball with no .git, a build in a sandbox).
 * 2. git, only if the checkout is this repository: from a tarball unpacked inside another repository, `HEAD` would be
 *    that one's.
 * 3. build/commit.txt, which `git archive` (and GitHub's source downloads) fills in.
 * 4. The mirror's variables.
 * Anything that is not a full commit hash is ignored.
 */
export function buildInfo(
  version: string,
  env: Record<string, string | undefined> = process.env,
  git: Git = runGit,
  archiveCommit: ArchiveCommit = readArchiveCommit,
): BuildInfo {
  const explicit = valid(env.SMARTCITY_COMMIT)
  if (explicit) return { version, commit: explicit, dirty: false }

  if (git(['rev-parse', '--show-prefix'])?.trim() === PREFIX) {
    const head = valid(git(['rev-parse', 'HEAD']))
    if (head) {
      const status = git(['status', '--porcelain', '--', ...BUNDLED_PATHS])
      return { version, commit: head, dirty: status !== undefined && status.trim() !== '' }
    }
  }

  const fallback = [archiveCommit(), ...COMMIT_VARS.map((name) => env[name])].map(valid).find((c) => c !== undefined)
  return { version, commit: fallback ?? '', dirty: false }
}
