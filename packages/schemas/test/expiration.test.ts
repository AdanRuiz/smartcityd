import { describe, expect, it } from 'vitest'
import { KIND, NOSTR_KIND, expirationOf } from '../src/index.js'

const at = (...values: string[]) => ({ kind: KIND.OBSERVATION, tags: values.map((v) => ['expiration', v]) })

describe('expirationOf (NIP-40, SNAP-16)', () => {
  it('reads a positive decimal integer from the first expiration tag', () => {
    expect(expirationOf(at('1800000000'))).toBe(1_800_000_000)
    expect(expirationOf({ kind: KIND.OBSERVATION, tags: [['c', 'mx-gdl']] })).toBeNull()
  })

  it('rejects any other spelling, so every implementation reads the same values', () => {
    for (const value of ['', '0', '-5', '+5', '1e9', '0x10', ' 42', '42 ', '42.0', '042', 'soon', '9007199254740993']) {
      expect(expirationOf(at(value)), value).toBeNull()
    }
  })

  it('only the first tag counts', () => {
    expect(expirationOf(at('soon', '1800000000'))).toBeNull()
    expect(expirationOf(at('1800000000', 'soon'))).toBe(1_800_000_000)
  })

  it('a kind 5 deletion never expires (DATA-8)', () => {
    expect(expirationOf({ kind: NOSTR_KIND.DELETION, tags: [['expiration', '1800000000']] })).toBeNull()
  })
})
