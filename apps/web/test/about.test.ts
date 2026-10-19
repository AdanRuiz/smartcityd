import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { BUNDLED_PATHS, buildInfo, type Git } from '../build/build-info'
import { SINGLE_FILE_META, singleFileHtml } from '../build/single-file'
import { isSameBuild, loadSelfCopy, selfCopyUrl } from '../src/about'
import { BUILD_META, VARIANT_META, buildIdOf, isSingleFile, runningBuildId } from '../src/variant'

const SHA = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)
const SHA256 = 'c'.repeat(64)

/** A fake git: answers each command from `answers`, by its arguments. */
const fakeGit = (answers: Record<string, string>): Git => (args) => answers[args.join(' ')]
const repo = (head: string, status = '') =>
  fakeGit({ 'rev-parse --show-prefix': 'apps/web/\n', 'rev-parse HEAD': `${head}\n`, [`status --porcelain -- ${BUNDLED_PATHS.join(' ')}`]: status })
const noGit: Git = () => undefined
const noArchive = () => undefined

describe('build info (APP-10, APP-6)', () => {
  it('takes the commit from git when the checkout is this repository', () => {
    expect(buildInfo('1.2.3', { CF_PAGES_COMMIT_SHA: OTHER }, repo(SHA), noArchive)).toEqual({ version: '1.2.3', commit: SHA, dirty: false })
  })

  it('lets SMARTCITY_COMMIT set it by hand, before anything else', () => {
    expect(buildInfo('1', { SMARTCITY_COMMIT: OTHER }, repo(SHA), () => SHA).commit).toBe(OTHER)
  })

  it('ignores the HEAD of another repository that encloses an unpacked tarball', () => {
    const outer = fakeGit({ 'rev-parse --show-prefix': 'smartcity-1.0/apps/web/\n', 'rev-parse HEAD': `${OTHER}\n` })
    expect(buildInfo('1', {}, outer, noArchive).commit).toBe('')
    expect(buildInfo('1', {}, outer, () => `${SHA}\n`).commit).toBe(SHA)
  })

  it('takes the commit that git archive writes in build/commit.txt', () => {
    expect(buildInfo('1', {}, noGit, () => `${SHA}\n`).commit).toBe(SHA)
    // In a checkout the file keeps its placeholder, which is not a commit.
    expect(buildInfo('1', {}, noGit, () => '$Format:%H$\n').commit).toBe('')
  })

  it("falls back to the mirror's variables (GOAL-3)", () => {
    expect(buildInfo('1', { CF_PAGES_COMMIT_SHA: SHA }, noGit, noArchive).commit).toBe(SHA)
    expect(buildInfo('1', { COMMIT_REF: SHA }, noGit, noArchive).commit).toBe(SHA)
    expect(buildInfo('1', { VERCEL_GIT_COMMIT_SHA: SHA.toUpperCase() }, noGit, noArchive).commit).toBe(SHA)
  })

  it('accepts the 64-character commits of a SHA-256 repository', () => {
    expect(buildInfo('1', {}, repo(SHA256), noArchive).commit).toBe(SHA256)
  })

  it('marks a build whose bundled code has uncommitted changes, new files included', () => {
    expect(buildInfo('1', {}, repo(SHA, ' M src/App.tsx\n'), noArchive)).toEqual({ version: '1', commit: SHA, dirty: true })
    expect(buildInfo('1', {}, repo(SHA, '?? src/new.ts\n'), noArchive).dirty).toBe(true)
  })

  it('looks only at what goes into the bundle: the app and the workspace packages', () => {
    expect(BUNDLED_PATHS).toEqual(['.', '../../packages'])
  })

  it('leaves the commit empty rather than show something that is not one', () => {
    expect(buildInfo('1', {}, noGit, noArchive).commit).toBe('')
    expect(buildInfo('1', { COMMIT_REF: 'main', SMARTCITY_COMMIT: 'v1.0' }, noGit, noArchive).commit).toBe('')
  })
})

/** A document with these `<meta name content>`, enough for the functions that read them. */
const docWith = (metas: Record<string, string>) => ({
  querySelector: (selector: string) => {
    const name = /^meta\[name="([^"]+)"\]$/.exec(selector)?.[1]
    const content = name === undefined ? undefined : metas[name]
    return content === undefined ? null : ({ getAttribute: (attr: string) => (attr === 'content' ? content : null) } as Element)
  },
})

describe('variant and build id of the running page (APP-4, APP-10)', () => {
  it('knows the single file by its meta', () => {
    expect(isSingleFile(docWith({ [VARIANT_META]: 'single-file' }))).toBe(true)
    expect(isSingleFile(docWith({ [VARIANT_META]: 'other' }))).toBe(false)
    expect(isSingleFile(docWith({}))).toBe(false)
  })

  it('reads the build id, or null in development', () => {
    expect(runningBuildId(docWith({ [BUILD_META]: '6e60d86824fd7ff3' }))).toBe('6e60d86824fd7ff3')
    expect(runningBuildId(docWith({}))).toBeNull()
  })

  it('reads the build id from the HTML of the build', () => {
    expect(buildIdOf(`<meta charset="UTF-8" />\n    <meta name="${BUILD_META}" content="6e60d86824fd7ff3" />`)).toBe('6e60d86824fd7ff3')
    expect(buildIdOf('<!doctype html><title>x</title>')).toBeNull()
  })
})

describe('copy of this app (APP-10, APP-4)', () => {
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

  it('hashes the bytes it downloads, the sha256 a release announces (DIST-2), and reads their build id', async () => {
    const html = `<!doctype html><meta name="${BUILD_META}" content="0123abcd" /><title>SmartCity</title>`
    const requests: { url: string; cache?: RequestCache }[] = []
    const fake = (async (url: string, init?: RequestInit) => {
      requests.push({ url, cache: init?.cache })
      return new Response(html)
    }) as typeof fetch
    const copy = await loadSelfCopy('https://m.example/smartcity.html', fake)
    expect(copy.sha256).toBe(createHash('sha256').update(html).digest('hex'))
    expect(copy.size).toBe(Buffer.byteLength(html))
    expect(copy.build).toBe('0123abcd')
    expect(new TextDecoder().decode(copy.bytes)).toBe(html)
    expect(requests).toEqual([{ url: 'https://m.example/smartcity.html', cache: 'no-cache' }])
  })

  it('tells a copy from another deploy apart from the build that is running', () => {
    expect(isSameBuild({ build: 'aaaa' }, 'aaaa')).toBe(true)
    expect(isSameBuild({ build: 'bbbb' }, 'aaaa')).toBe(false)
    expect(isSameBuild({ build: null }, 'aaaa')).toBe(false)
    // Development: the page has no id.
    expect(isSameBuild({ build: null }, null)).toBe(true)
  })

  it('keeps the build id of index.html in smartcity.html', () => {
    const index = [
      '<!doctype html><html><head>',
      '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'" />',
      `<meta name="${BUILD_META}" content="feedbeef" />`,
      '<script defer src="./assets/app.js"></script>',
      '<link rel="stylesheet" href="./assets/style.css">',
      '</head><body></body></html>',
    ].join('\n')
    const single = singleFileHtml(index, (path) => (path.endsWith('.js') ? 'void 0' : 'body{}'))
    expect(buildIdOf(single)).toBe('feedbeef')
    expect(single).toContain(SINGLE_FILE_META)
  })

  it('fails on an HTTP error or without Web Crypto', async () => {
    const missing = (async () => new Response('no', { status: 404 })) as unknown as typeof fetch
    await expect(loadSelfCopy('https://m.example/smartcity.html', missing)).rejects.toThrow(/404/)
    const ok = (async () => new Response('x')) as unknown as typeof fetch
    await expect(loadSelfCopy('http://m.example/smartcity.html', ok, null)).rejects.toThrow(/sha256/)
  })
})
