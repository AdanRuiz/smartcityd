import { KIND } from '@smartcity/schemas'
import { getPow } from 'nostr-tools/nip13'
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey } from 'nostr-tools/pure'
import { describe, expect, it } from 'vitest'
import { decide, readPolicyConfig } from '../src/rules.js'

const NOW = 1_760_000_000
const G = [['g', '9ewm'], ['g', '9ewmq'], ['g', '9ewmqx']]
const sk = generateSecretKey()
const sign = (kind: number, tags: string[][], content: unknown, created_at = NOW) =>
  finalizeEvent({ kind, tags, content: JSON.stringify(content), created_at }, sk)

function report(bits: number) {
  const pubkey = getPublicKey(sk)
  const base = { kind: KIND.REPORT, created_at: NOW, content: JSON.stringify({ v: 1, title: 'Bache', loc: [20.66, -103.39] }), pubkey }
  for (let n = 0; ; n++) {
    const candidate = { ...base, tags: [['c', 'mx-gdl'], ['t', 'bache'], ...G, ['nonce', String(n), String(bits)]] }
    if (getPow(getEventHash(candidate)) >= bits) return finalizeEvent(candidate, sk)
  }
}

const config = readPolicyConfig({ POW_BITS_REPORT: '8' })
const obs = (city = 'mx-gdl', created_at = NOW) =>
  sign(KIND.OBSERVATION, [['c', city], ['a', `${KIND.DATASET}:${getPublicKey(sk)}:air`], ...G], { v: 1, loc: [20.66, -103.39], obs: [{ ts: NOW, values: { pm25: 1 } }] }, created_at)

describe('strfry write policy (docs/spec/07 steps 2, 3, 7, 8, 9)', () => {
  it('accepts a valid observation', () => {
    expect(decide(obs(), config, NOW)).toBeNull()
  })

  it('rejects kinds outside the system and reused NIPs', () => {
    expect(decide(sign(1, [], 'hola'), config, NOW)).toBe('blocked: kind 1 is not accepted by this relay')
  })

  it('rejects dates from the future and regular events that are too old', () => {
    expect(decide(obs('mx-gdl', NOW + 3600), config, NOW)).toMatch(/^invalid: created_at/)
    expect(decide(obs('mx-gdl', NOW - 40 * 86_400), config, NOW)).toBe('invalid: too old')
  })

  it('rejects content that does not match its schema', () => {
    expect(decide(sign(KIND.OBSERVATION, [['c', 'mx-gdl']], { v: 1, obs: [] }), config, NOW)).toMatch(/^invalid: /)
  })

  it('asks reports for proof of work', () => {
    expect(decide(report(0), config, NOW)).toBe('pow: difficulty 8 required')
    expect(decide(report(8), config, NOW)).toBeNull()
  })

  it('restricts cities when configured', () => {
    const only = readPolicyConfig({ CITIES: 'mx-cdmx' })
    expect(decide(obs(), only, NOW)).toBe('restricted: city mx-gdl is not served by this relay')
  })
})
