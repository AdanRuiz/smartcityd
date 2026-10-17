import { KIND, validateEvent } from '@smartcity/schemas'
import { describe, expect, it } from 'vitest'
import { ValidationError, releaseTemplate, type ReleaseInput } from '../src/index.js'

const X = 'ab'.repeat(32)
const input: ReleaseInput = {
  version: '1.0.0',
  commit: '6f50048',
  single: { x: X, size: 2_200_000, urls: ['https://example.org/smartcity.html'] },
}

describe('releaseTemplate (docs/spec/06, APP-4, DIST-2)', () => {
  it('builds a valid release for the stable channel of the app', () => {
    const template = releaseTemplate(input)
    expect(template.kind).toBe(KIND.RELEASE)
    expect(template.tags).toEqual([
      ['d', 'smartcity:stable'],
      ['x', X],
    ])
    expect(JSON.parse(template.content)).toEqual({ v: 1, ...input })
    expect(validateEvent(template).ok).toBe(true)
  })

  it('carries channel, dist, mirrors and notes, and leaves out the empty ones', () => {
    const full = releaseTemplate({
      ...input,
      slug: 'fork',
      channel: 'beta',
      dist: { cid: 'bafyexample', magnet: 'magnet:?xt=urn:btih:abc&ws=https://example.org/' },
      mirrors: ['https://smartcity-web.pages.dev'],
      notes: 'Primera versión',
    })
    expect(full.tags[0]).toEqual(['d', 'fork:beta'])
    expect(JSON.parse(full.content)).toMatchObject({ dist: { cid: 'bafyexample' }, mirrors: ['https://smartcity-web.pages.dev'], notes: 'Primera versión' })

    const bare = JSON.parse(releaseTemplate({ ...input, dist: {}, mirrors: [], notes: '' }).content)
    expect(Object.keys(bare).sort()).toEqual(['commit', 'single', 'v', 'version'])
  })

  it('rejects what the schema or the d tag does not allow', () => {
    const bad: [string, ReleaseInput][] = [
      ['slug with a colon', { ...input, slug: 'a:b' }],
      ['empty slug', { ...input, slug: '' }],
      ['unknown channel', { ...input, channel: 'nightly' as 'beta' }],
      ['hash that is not sha256 hex', { ...input, single: { ...input.single, x: 'ABC' } }],
      ['empty version', { ...input, version: '' }],
      ['magnet that is not a magnet', { ...input, dist: { magnet: 'https://example.org' } }],
    ]
    for (const [name, value] of bad) {
      expect(() => releaseTemplate(value), name).toThrow(ValidationError)
    }
  })
})
