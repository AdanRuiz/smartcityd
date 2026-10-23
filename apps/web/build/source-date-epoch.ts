import { inThisRepository, runGit, type Git } from './git.ts'

/**
 * APP-6, reproducible build: `SOURCE_DATE_EPOCH`
 * (<https://reproducible-builds.org/specs/source-date-epoch/>) is the time the build must use instead of the clock.
 * Nothing in the bytes of this build comes from a date today; the variable is the contract with the toolchain, so a
 * third party who builds the same commit gets the same file whatever the hour and the time zone of their machine.
 */
export const SOURCE_DATE_EPOCH = 'SOURCE_DATE_EPOCH'

// Seconds since 1970, no sign, no fraction.
const SECONDS = /^\d+$/

/**
 * A SOURCE_DATE_EPOCH value, in seconds since 1970, or undefined if the variable is not set. A value that is not a
 * whole number of seconds is an error, not something to ignore: a build that ignored it could date its output with the
 * clock and break the hash the `release` announces (DIST-2).
 */
export function parseSourceDateEpoch(value: string | undefined): number | undefined {
  const text = value?.trim()
  if (!text) return undefined
  const seconds = Number(text)
  if (!SECONDS.test(text) || !Number.isSafeInteger(seconds)) {
    throw new Error(`${SOURCE_DATE_EPOCH} must be a whole number of seconds since 1970 (got "${value}")`)
  }
  return seconds
}

/** Time of HEAD, in seconds since 1970, or undefined if git is missing or the checkout is not this repository. */
export function commitTime(git: Git = runGit): number | undefined {
  if (!inThisRepository(git)) return undefined
  const out = git(['log', '-1', '--format=%ct', 'HEAD'])?.trim()
  return out !== undefined && SECONDS.test(out) ? Number(out) : undefined
}

/**
 * APP-6: the time this build uses. `SOURCE_DATE_EPOCH` if it is set; otherwise the commit time, so two builds of the
 * same commit agree without anyone setting it; otherwise the clock, which nothing in the build reads.
 */
export function sourceDateEpoch(
  env: Record<string, string | undefined> = process.env,
  git: Git = runGit,
  now: () => number = () => Math.floor(Date.now() / 1000),
): number {
  return parseSourceDateEpoch(env[SOURCE_DATE_EPOCH]) ?? commitTime(git) ?? now()
}
