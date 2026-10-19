import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The HTTP mirrors (docs/spec/06, GOAL-3) build the same commit with the same command and serve the same dist/.
const root = new URL('../../../', import.meta.url)
const read = (file: string) => readFileSync(new URL(file, root), 'utf8').replace(/\r\n/g, '\n')

const BUILD = 'pnpm --filter web... build'
const PUBLISH = 'apps/web/dist'

/** `key = "value"` pairs of one TOML table, enough for netlify.toml. */
function tomlTable(toml: string, table: string): Record<string, string> {
  const start = toml.indexOf(`\n[${table}]\n`)
  if (start < 0) return {}
  const body = toml.slice(start + table.length + 4).split(/\n\[/)[0] ?? ''
  return Object.fromEntries([...body.matchAll(/^\s*([\w.-]+)\s*=\s*"([^"]*)"/gm)].map((m) => [m[1], m[2]]))
}

/** Header values per path of netlify.toml. */
function tomlHeaders(toml: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  for (const block of toml.split('[[headers]]').slice(1)) {
    const path = /for\s*=\s*"([^"]*)"/.exec(block)?.[1] ?? ''
    out[path] = Object.fromEntries([...block.matchAll(/^\s*([\w-]+)\s*=\s*"([^"]*)"/gm)].filter((m) => m[1] !== 'for').map((m) => [m[1], m[2]]))
  }
  return out
}

interface Vercel {
  framework: null
  installCommand: string
  buildCommand: string
  outputDirectory: string
  headers: { source: string; headers: { key: string; value: string }[] }[]
  [key: string]: unknown
}

const netlify = read('netlify.toml')
const vercel = JSON.parse(read('vercel.json')) as Vercel
const vercelHeaders = Object.fromEntries(vercel.headers.map((h) => [h.source, Object.fromEntries(h.headers.map((x) => [x.key, x.value]))]))

describe('HTTP mirrors (GOAL-3, APP-1)', () => {
  it('build the app and its workspace packages from the lockfile and publish dist/', () => {
    const build = tomlTable(netlify, 'build')
    expect(build.publish).toBe(PUBLISH)
    expect(build.command).toBe(`corepack enable pnpm && pnpm install --frozen-lockfile && ${BUILD}`)
    expect(vercel.outputDirectory).toBe(PUBLISH)
    expect(`${vercel.installCommand} && ${vercel.buildCommand}`).toBe(build.command)
    expect(vercel.framework).toBeNull()
  })

  it('publish where Vite writes the build', () => {
    const vite = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8')
    // Vite's default outDir is dist/; a different one would leave the mirrors serving nothing.
    expect(vite).not.toMatch(/outDir/)
  })

  it('serve only static files: no functions, redirects, rewrites or runtime variables (APP-1, APP-2)', () => {
    expect(netlify).not.toMatch(/\[\[redirects\]\]|\[functions\]|\[\[edge_functions\]\]|\[\[plugins\]\]/)
    for (const key of ['rewrites', 'redirects', 'functions', 'routes', 'env', 'build', 'crons']) expect(vercel).not.toHaveProperty(key)
  })

  it('always revalidate the Service Worker and cache hashed assets for good (APP-7)', () => {
    const headers = tomlHeaders(netlify)
    expect(headers['/sw.js']?.['Cache-Control']).toBe('no-cache')
    expect(vercelHeaders['/sw.js']?.['Cache-Control']).toBe('no-cache')
    expect(headers['/assets/*']?.['Cache-Control']).toContain('immutable')
    expect(vercelHeaders['/assets/(.*)']?.['Cache-Control']).toContain('immutable')
  })

  it('send no referrer from any page (PRIV-7)', () => {
    expect(tomlHeaders(netlify)['/*']?.['Referrer-Policy']).toBe('no-referrer')
    expect(vercelHeaders['/(.*)']?.['Referrer-Policy']).toBe('no-referrer')
  })
})
