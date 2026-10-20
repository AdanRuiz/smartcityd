import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Git } from '../build/git'
import { commitTime, parseSourceDateEpoch, sourceDateEpoch } from '../build/source-date-epoch'
import { SINGLE_FILE } from '../src/variant'

const appDir = fileURLToPath(new URL('..', import.meta.url))
const viteBin = join(dirname(createRequire(import.meta.url).resolve('vite/package.json')), 'bin', 'vite.js')

const fakeGit = (answers: Record<string, string>): Git => (args) => answers[args.join(' ')]
const repo = (seconds: string) =>
  fakeGit({ 'rev-parse --show-prefix': 'apps/web/\n', 'log -1 --format=%ct HEAD': `${seconds}\n` })
const noGit: Git = () => undefined
const at = (seconds: number) => () => seconds

describe('SOURCE_DATE_EPOCH (APP-6)', () => {
  it('reads seconds since 1970 and treats an unset value as absent', () => {
    expect(parseSourceDateEpoch(undefined)).toBeUndefined()
    expect(parseSourceDateEpoch('')).toBeUndefined()
    expect(parseSourceDateEpoch('  ')).toBeUndefined()
    expect(parseSourceDateEpoch('0')).toBe(0)
    expect(parseSourceDateEpoch('1700000000\n')).toBe(1700000000)
  })

  it('rejects anything that is not a whole number of seconds, instead of falling back to the clock', () => {
    for (const value of ['2026-10-20', 'yesterday', '-1', '1.5', '1e9', '0x10', 'now']) {
      expect(() => parseSourceDateEpoch(value), value).toThrow(/SOURCE_DATE_EPOCH/)
    }
  })

  it('uses the value given, before the commit', () => {
    expect(sourceDateEpoch({ SOURCE_DATE_EPOCH: '1000' }, repo('2000'), at(3000))).toBe(1000)
    expect(sourceDateEpoch({ SOURCE_DATE_EPOCH: '1000' }, noGit, at(3000))).toBe(1000)
  })

  it('fails on an invalid value even when another default is available', () => {
    expect(() => sourceDateEpoch({ SOURCE_DATE_EPOCH: 'main' }, repo('2000'), at(3000))).toThrow(/SOURCE_DATE_EPOCH/)
  })

  it('defaults to the time of the commit, so a third party gets the same value without setting it', () => {
    expect(commitTime(repo('2000'))).toBe(2000)
    expect(sourceDateEpoch({}, repo('2000'), at(3000))).toBe(2000)
  })

  it('ignores the commit of another repository that encloses an unpacked tarball', () => {
    const outer = fakeGit({ 'rev-parse --show-prefix': 'smartcity-1.0/apps/web/\n', 'log -1 --format=%ct HEAD': '2000\n' })
    expect(commitTime(outer)).toBeUndefined()
    expect(sourceDateEpoch({}, outer, at(3000))).toBe(3000)
  })

  it('falls back to the clock only where nothing reads it', () => {
    expect(commitTime(noGit)).toBeUndefined()
    expect(sourceDateEpoch({}, noGit, at(3000))).toBe(3000)
  })
})

/** Runs `vite build` into a new empty directory and returns it; a failed build leaves no directory behind. */
function build(env: Record<string, string | undefined>): string {
  // Inside node_modules: git-ignored, so the build keeps seeing a clean checkout.
  const outDir = mkdtempSync(join(appDir, 'node_modules', '.repro-'))
  const childEnv: Record<string, string | undefined> = { ...process.env, ...env }
  for (const [name, value] of Object.entries(env)) if (value === undefined) delete childEnv[name]
  try {
    execFileSync(process.execPath, [viteBin, 'build', '--outDir', outDir, '--logLevel', 'error'], {
      cwd: appDir,
      env: childEnv,
      stdio: 'pipe',
    })
  } catch (error) {
    rmSync(outDir, { recursive: true, force: true })
    throw error
  }
  return outDir
}

/** Everything a failed command wrote, to look for a message in it. */
const outputOf = (error: unknown) => {
  const failed = error as { message?: string; stdout?: Buffer | string; stderr?: Buffer | string }
  return [failed.message, String(failed.stdout ?? ''), String(failed.stderr ?? '')].join('\n')
}

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

/** Every file of a build, by relative path, with its sha256. */
function tree(dir: string): Record<string, string> {
  const files: Record<string, string> = {}
  const walk = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name)
      if (statSync(path).isDirectory()) walk(path)
      else files[relative(dir, path)] = sha256(path)
    }
  }
  walk(dir)
  return files
}

// APP-6: the same commit, built twice in time zones with different clocks, gives the same bytes. One build takes
// SOURCE_DATE_EPOCH from its default (the commit) and the other gets it by hand, which is what a third party does.
describe('reproducible build (APP-6)', () => {
  it(
    'gives the same smartcity.html for two builds of the same commit',
    () => {
      const epoch = commitTime() ?? sourceDateEpoch({}, noGit, at(0))
      const first = build({ TZ: 'UTC', SOURCE_DATE_EPOCH: undefined })
      const second = build({ TZ: 'Pacific/Auckland', SOURCE_DATE_EPOCH: String(epoch) })
      try {
        expect(sha256(join(second, SINGLE_FILE))).toBe(sha256(join(first, SINGLE_FILE)))
        // Nothing else in dist/ depends on the clock or the time zone either (APP-4, APP-7).
        expect(tree(second)).toEqual(tree(first))
      } finally {
        rmSync(first, { recursive: true, force: true })
        rmSync(second, { recursive: true, force: true })
      }
    },
    120_000,
  )

  it(
    'stops the build when SOURCE_DATE_EPOCH is not a whole number of seconds',
    () => {
      let output = ''
      try {
        const outDir = build({ SOURCE_DATE_EPOCH: '2026-10-20' })
        rmSync(outDir, { recursive: true, force: true })
      } catch (error) {
        output = outputOf(error)
      }
      expect(output).toMatch(/SOURCE_DATE_EPOCH must be a whole number of seconds/)
    },
    120_000,
  )
})
