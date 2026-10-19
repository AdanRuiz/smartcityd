import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildInfo } from '../build/build-info'
import { SINGLE_FILE as BUILT } from '../build/single-file'
import { SINGLE_FILE, loadSelfCopy, selfCopyUrl } from '../src/about'

const SHA = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)

describe('build info (APP-10)', () => {
  it('takes the commit from git first', () => {
    expect(buildInfo('1.2.3', { CF_PAGES_COMMIT_SHA: OTHER }, () => `${SHA}\n`)).toEqual({ version: '1.2.3', commit: SHA })
  })

  it("falls back to the mirror's variables when the checkout has no git (GOAL-3)", () => {
    const noGit = () => undefined
    expect(buildInfo('1', { CF_PAGES_COMMIT_SHA: SHA }, noGit).commit).toBe(SHA)
    expect(buildInfo('1', { COMMIT_REF: SHA }, noGit).commit).toBe(SHA)
    expect(buildInfo('1', { VERCEL_GIT_COMMIT_SHA: SHA.toUpperCase() }, noGit).commit).toBe(SHA)
  })

  it('leaves the commit empty rather than show something that is not one', () => {
    expect(buildInfo('1', {}, () => undefined).commit).toBe('')
    expect(buildInfo('1', { COMMIT_REF: 'main' }, () => 'fatal: not a git repository').commit).toBe('')
  })
})

describe('copy of this app (APP-10, APP-4)', () => {
  it('names the file as the build writes it', () => {
    expect(SINGLE_FILE).toBe(BUILT)
  })

  it('reads smartcity.html next to index.html, on any mirror or IPFS subpath', () => {
    expect(selfCopyUrl('https://smartcity-web.pages.dev/#/acerca', false)).toBe('https://smartcity-web.pages.dev/smartcity.html')
    expect(selfCopyUrl('https://gw.example/ipfs/bafy/index.html#/acerca', false)).toBe('https://gw.example/ipfs/bafy/smartcity.html')
    expect(selfCopyUrl('http://localhost:4173/', false)).toBe('http://localhost:4173/smartcity.html')
  })

  it('reads the page itself in the single file', () => {
    expect(selfCopyUrl('https://m.example/app/smartcity.html#/acerca', true)).toBe('https://m.example/app/smartcity.html')
  })

  it('does not try from file://, where the browser forbids it', () => {
    expect(selfCopyUrl('file:///C:/Descargas/smartcity.html#/acerca', true)).toBeNull()
    expect(selfCopyUrl('file:///home/a/dist/index.html', false)).toBeNull()
  })

  it('hashes the bytes it downloads, the sha256 a release announces (DIST-2)', async () => {
    const html = '<!doctype html><title>SmartCity</title>'
    const requests: { url: string; cache?: RequestCache }[] = []
    const fake = (async (url: string, init?: RequestInit) => {
      requests.push({ url, cache: init?.cache })
      return new Response(html)
    }) as typeof fetch
    const copy = await loadSelfCopy('https://m.example/smartcity.html', fake)
    expect(copy.sha256).toBe(createHash('sha256').update(html).digest('hex'))
    expect(copy.size).toBe(Buffer.byteLength(html))
    expect(new TextDecoder().decode(copy.bytes)).toBe(html)
    expect(requests).toEqual([{ url: 'https://m.example/smartcity.html', cache: 'no-cache' }])
  })

  it('fails on an HTTP error or without Web Crypto', async () => {
    const missing = (async () => new Response('no', { status: 404 })) as unknown as typeof fetch
    await expect(loadSelfCopy('https://m.example/smartcity.html', missing)).rejects.toThrow(/404/)
    const ok = (async () => new Response('x')) as unknown as typeof fetch
    await expect(loadSelfCopy('http://m.example/smartcity.html', ok, null)).rejects.toThrow(/sha256/)
  })
})
