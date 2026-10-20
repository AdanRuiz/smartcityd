import { KIND } from '@smartcity/schemas'
import { releaseTemplate, type Filter } from '@smartcity/sdk'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { describe, expect, it } from 'vitest'
import { defaults, parseSettings } from '../src/settings'
import {
  checkUpdates,
  isNewerVersion,
  parseVersion,
  releaseChannels,
  releaseOffers,
  type ReleaseCheck,
} from '../src/updates'

const secret = generateSecretKey()
const developer = getPublicKey(secret)
const stranger = getPublicKey(generateSecretKey())
const X = 'a'.repeat(64)
const URL = 'https://m.example/smartcity.html'

/** A signed `release` as the SDK drafts it. */
function release(
  input: Partial<Parameters<typeof releaseTemplate>[0]> = {},
  { signer = secret, at = 1000, tags }: { signer?: Uint8Array; at?: number; tags?: string[][] } = {},
) {
  const template = releaseTemplate({
    version: '1.0.0',
    commit: 'c'.repeat(40),
    single: { x: X, size: 1234, urls: [URL] },
    ...input,
  })
  return finalizeEvent({ ...template, tags: tags ?? template.tags, created_at: at }, signer)
}

const check = (current = '0.1.0', developers: string[] = [developer]): ReleaseCheck => ({ developers, current })

describe('semantic versions (APP-8)', () => {
  it('reads the numbers of a version and nothing else', () => {
    expect(parseVersion('1.4.0')).toEqual({ major: 1, minor: 4, patch: 0 })
    expect(parseVersion('v1.4.2')).toEqual({ major: 1, minor: 4, patch: 2 })
    expect(parseVersion('1.5.0-beta.1')).toEqual({ major: 1, minor: 5, patch: 0 })
    expect(parseVersion('1.4')).toBeNull()
    expect(parseVersion('main')).toBeNull()
    expect(parseVersion('2026-10-12')).toBeNull()
    expect(parseVersion('')).toBeNull()
  })

  it('says whether a release is newer than the build that runs', () => {
    expect(isNewerVersion('0.1.0', '1.0.0')).toBe(true)
    expect(isNewerVersion('1.0.0', '1.1.0')).toBe(true)
    expect(isNewerVersion('1.0.0', '1.0.1')).toBe(true)
    expect(isNewerVersion('1.0.0', '1.0.0')).toBe(false)
    expect(isNewerVersion('2.0.0', '1.9.9')).toBe(false)
    expect(isNewerVersion('1.0.0', '1.1.0-beta.1')).toBe(true)
    // A pre-release of the version already running is not news.
    expect(isNewerVersion('1.0.0', '1.0.0-beta')).toBe(false)
    // Without two versions to compare, there is nothing to warn about.
    expect(isNewerVersion('main', '1.0.0')).toBe(false)
    expect(isNewerVersion('1.0.0', 'latest')).toBe(false)
  })
})

describe('releases the app believes (APP-8)', () => {
  it('offers a newer release signed by a developer key', () => {
    const event = release({ version: '1.0.0' })
    const [offer] = releaseOffers([event], check())
    expect(offer?.channel).toBe('stable')
    expect(offer?.version).toBe('1.0.0')
    expect(offer?.content.commit).toBe('c'.repeat(40))
    expect(offer?.event.id).toBe(event.id)
  })

  it('ignores a release signed by a key the build does not carry', () => {
    expect(releaseOffers([release({ version: '2.0.0' }, { signer: generateSecretKey() })], check())).toEqual([])
    expect(releaseOffers([release({ version: '2.0.0' }, { signer: generateSecretKey() })], check('0.1.0', [stranger]))).toEqual([])
  })

  it('ignores another app and a version that is not newer', () => {
    expect(releaseOffers([release({ version: '2.0.0', slug: 'otra' })], check())).toEqual([])
    expect(releaseOffers([release({ version: '0.1.0' })], check())).toEqual([])
    expect(releaseOffers([release({ version: '1.0.0', channel: 'beta' })], check('1.0.0'))).toEqual([])
  })

  it('keeps the newest release of each channel and offers stable before beta', () => {
    const events = [
      release({ version: '1.0.0' }, { at: 1000 }),
      release({ version: '1.1.0' }, { at: 2000 }),
      release({ version: '2.0.0', channel: 'beta' }, { at: 1500 }),
    ]
    const offers = releaseOffers(events, check())
    expect(offers.map((o) => [o.channel, o.version])).toEqual([
      ['stable', '1.1.0'],
      ['beta', '2.0.0'],
    ])
  })

  it('ignores an event that is not a valid release for this app', () => {
    const bad = finalizeEvent(
      { kind: KIND.RELEASE, tags: [['d', 'smartcity:stable'], ['x', X]], content: '{"v":1}', created_at: 3000 },
      secret,
    )
    expect(releaseOffers([bad], check())).toEqual([])
  })

  it('does nothing without developer keys or a version to compare', () => {
    expect(releaseOffers([release({ version: '1.0.0' })], check('0.1.0', []))).toEqual([])
    expect(releaseOffers([release({ version: '1.0.0' })], check('dev'))).toEqual([])
  })
})

describe('querying the release (APP-8)', () => {
  it('asks for the release of each channel by its author', async () => {
    const seen: Filter[][] = []
    const event = release({ version: '1.0.0' })
    const offers = await checkUpdates((filters) => {
      seen.push(filters)
      return Promise.resolve(filters.length > 0 ? [event] : [])
    }, check())
    expect(seen).toEqual([
      [
        { kinds: [KIND.RELEASE], authors: [developer], '#d': ['smartcity:stable'] },
        { kinds: [KIND.RELEASE], authors: [developer], '#d': ['smartcity:beta'] },
      ],
    ])
    expect(offers.map((o) => o.channel)).toEqual(['stable'])
  })

  it('asks no relay when there is no key to believe', async () => {
    let asked = false
    const offers = await checkUpdates(() => {
      asked = true
      return Promise.resolve([])
    }, check('0.1.0', []))
    expect(asked).toBe(false)
    expect(offers).toEqual([])
  })
})

describe('channels of an announced version (APP-8, SEC-1)', () => {
  it('only turns https URLs into links and shows the torrent as text', () => {
    const content = {
      v: 1 as const,
      version: '2.0.0',
      commit: 'c'.repeat(40),
      single: {
        x: X,
        size: 10,
        urls: ['https://m.example/smartcity.html', 'http://plain.example/smartcity.html', 'javascript:alert(1)'],
      },
      dist: { cid: 'bafyexample', magnet: 'magnet:?xt=urn:btih:abc&ws=https%3A%2F%2Fm.example' },
      mirrors: ['https://smartcity.pages.dev', 'data:text/html,hi'],
    }
    const channels = releaseChannels(content)
    expect(channels.downloads).toEqual(['https://m.example/smartcity.html'])
    expect(channels.mirrors).toEqual(['https://smartcity.pages.dev'])
    expect(channels.ipfs).toEqual(['https://ipfs.io/ipfs/bafyexample/', 'https://dweb.link/ipfs/bafyexample/'])
    expect(channels.magnet).toBe('magnet:?xt=urn:btih:abc&ws=https%3A%2F%2Fm.example')
  })

  it('has nothing to offer when the release names no channel', () => {
    expect(releaseChannels({ v: 1, version: '2.0.0', commit: 'c', single: { x: X, size: 0, urls: [] } })).toEqual({
      downloads: [],
      mirrors: [],
      ipfs: [],
      magnet: null,
    })
  })
})

describe('developer keys in settings (APP-5, APP-8)', () => {
  it('keeps only hex keys and drops repeats', () => {
    expect(parseSettings({ developers: [developer, developer, 'npub1nothex'] }).developers).toEqual([developer])
  })

  it('reads an empty list as the user turning the notice off, and falls back to the keys of the build', () => {
    expect(parseSettings({ developers: [] }).developers).toEqual([])
    expect(parseSettings({}).developers).toEqual(defaults().developers)
  })
})
