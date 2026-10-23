import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Shared by the build plugins that ask git about this checkout (APP-6, APP-10).

/** Runs git in apps/web and returns its output, or undefined if git is missing or fails. */
export type Git = (args: string[]) => string | undefined

// Where apps/web sits in this repository, as `git rev-parse --show-prefix` prints it from there.
const PREFIX = 'apps/web/'

const appDir = fileURLToPath(new URL('..', import.meta.url))

export const runGit: Git = (args) => {
  try {
    return execFileSync('git', args, { cwd: appDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return undefined
  }
}

/**
 * True if git is answering for this repository. From a tarball unpacked inside another repository, the commands would
 * answer for the enclosing one, whose commit and dates are not this code's.
 */
export function inThisRepository(git: Git = runGit): boolean {
  return git(['rev-parse', '--show-prefix'])?.trim() === PREFIX
}
