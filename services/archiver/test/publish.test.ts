import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { KIND, validateEvent, type SignedEvent } from '@smartcity/schemas'
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import { describe, expect, it } from 'vitest'
import { GRACE_SECONDS } from '../src/daily.js'
import { runPublish, type Post, type PublishDeps } from '../src/publish.js'
import type { Fetch } from '../src/relays.js'
import { runSnapshot } from '../src/snapshot.js'

const CITY = 'mx-gdl'
const DAY = '2025-10-09'
const FROM = 1_759_968_000
const AFTER_GRACE = FROM + 86_400 + GRACE_SECONDS

/** One relay that serves a single observation through `GET /v1/export`, for `archiver snapshot` to have a file. */
async function written() {
  const sk = generateSecretKey()
  const pk = getPublicKey(sk)
  const obs = finalizeEvent({
    kind: KIND.OBSERVATION,
    tags: [['c', CITY], ['a', `${KIND.DATASET}:${pk}:aire`], ['g', '9ewm'], ['g', '9ewmq'], ['g', '9ewmqx']],
    content: JSON.stringify({ v: 1, obs: [{ ts: FROM + 1, values: { pm25: 12 } }] }),
    created_at: FROM + 1,
  }, sk)
  const fetch: Fetch = async (url) => new Response(new URL(url).pathname === '/v1/export' ? JSON.stringify(obs) + '\n' : '')
  const out = await mkdtemp(join(tmpdir(), 'archiver-publish-'))
  const result = await runSnapshot({ city: CITY, day: DAY, relays: ['wss://a.example'], out }, { fetch, now: AFTER_GRACE, log: () => {} })
  return result.files
}

/** Relays over `fetch` that answer `POST /v1/events` like the reference relay, each with a fixed verdict. */
function relays(verdicts: Record<string, { status: number; body: unknown } | 'down'>) {
  const received: { origin: string; event: SignedEvent }[] = []
  const post: Post = async (url, init) => {
    const { origin, pathname } = new URL(url)
    const verdict = verdicts[origin]
    if (!verdict || verdict === 'down') throw new Error('connection refused')
    expect(pathname).toBe('/v1/events')
    expect(init.method).toBe('POST')
    received.push({ origin, event: JSON.parse(init.body) as SignedEvent })
    return new Response(JSON.stringify(verdict.body), { status: verdict.status })
  }
  return { post, received }
}

function deps(post: Post, sk: Uint8Array, now = AFTER_GRACE + 60): PublishDeps & { asked: () => number; logs: string[] } {
  let asked = 0
  const logs: string[] = []
  return {
    fetch: post,
    now,
    secretKey: async () => (asked++, Uint8Array.from(sk)),
    log: (line) => logs.push(line),
    asked: () => asked,
    logs,
  }
}

const ok = { status: 200, body: { ok: true, id: 'x' } }

describe('archiver publish (DIST-2)', () => {
  it('signs the snapshot event with the archiver key and sends it to every relay', async () => {
    const files = await written()
    const sk = generateSecretKey()
    const { post, received } = relays({
      'https://a.example': ok,
      'https://b.example': { status: 400, body: { ok: false, reason: 'blocked: not allowed' } },
      'https://c.example': 'down',
    })
    const d = deps(post, sk)
    const result = await runPublish({ event: files.event, relays: ['wss://a.example', 'wss://b.example', 'wss://c.example'] }, d)

    const template = JSON.parse(await readFile(files.event, 'utf8')) as { tags: string[][]; content: string }
    expect(verifyEvent(result.event)).toBe(true)
    expect(validateEvent(result.event).ok).toBe(true)
    expect(result.event.pubkey).toBe(getPublicKey(sk))
    expect(result.event.created_at).toBe(AFTER_GRACE + 60)
    expect(result.event.content).toBe(template.content)
    expect(result.event.tags).toEqual(template.tags)
    expect(await readFile(result.signed, 'utf8')).toBe(JSON.stringify(result.event, null, 2) + '\n')
    expect(received.map((r) => r.event.id)).toEqual([result.event.id, result.event.id])
    expect(result.accepted).toEqual(['wss://a.example'])
    expect(result.rejected).toEqual([
      { relay: 'wss://b.example', reason: 'blocked: not allowed' },
      { relay: 'wss://c.example', reason: 'connection refused' },
    ])
  })

  it('signs only once: a later run resends the same event without asking for the key', async () => {
    const files = await written()
    const sk = generateSecretKey()
    const first = deps(relays({ 'https://a.example': 'down' }).post, sk)
    await expect(runPublish({ event: files.event, relays: ['wss://a.example'] }, first)).rejects.toThrow(/no relay accepted/)
    expect(first.asked()).toBe(1)

    const { post, received } = relays({ 'https://a.example': ok })
    const again = deps(post, generateSecretKey(), AFTER_GRACE + 3600)
    const result = await runPublish({ event: files.event, relays: ['wss://a.example'] }, again)
    expect(again.asked()).toBe(0)
    expect(result.event.pubkey).toBe(getPublicKey(sk))
    expect(result.event.created_at).toBe(AFTER_GRACE + 60)
    expect(received).toHaveLength(1)
  })

  it('refuses to sign when the archive no longer matches the x of its event (SNAP-6)', async () => {
    const files = await written()
    await writeFile(files.archive, gzipSync('{}\n'))
    const { post, received } = relays({ 'https://a.example': ok })
    const d = deps(post, generateSecretKey())
    await expect(runPublish({ event: files.event, relays: ['wss://a.example'] }, d)).rejects.toThrow(/does not match/)
    expect(d.asked()).toBe(0)
    expect(received).toEqual([])
  })

  it('refuses a signed copy that is not a signature of the template', async () => {
    const files = await written()
    const template = JSON.parse(await readFile(files.event, 'utf8')) as { kind: number; tags: string[][] }
    const other = finalizeEvent({ kind: template.kind, tags: template.tags, content: '{}', created_at: AFTER_GRACE }, generateSecretKey())
    await writeFile(files.event.replace(/\.snapshot\.json$/, '.snapshot.signed.json'), JSON.stringify(other))
    const { post, received } = relays({ 'https://a.example': ok })
    await expect(runPublish({ event: files.event, relays: ['wss://a.example'] }, deps(post, generateSecretKey()))).rejects.toThrow(
      /not a valid signature/,
    )
    expect(received).toEqual([])
  })

  it('needs a relay and a snapshot template', async () => {
    const files = await written()
    const { post } = relays({})
    await expect(runPublish({ event: files.event, relays: [] }, deps(post, generateSecretKey()))).rejects.toThrow(/--relay/)
    await expect(runPublish({ event: files.archive, relays: ['wss://a.example'] }, deps(post, generateSecretKey()))).rejects.toThrow(
      /snapshot\.json/,
    )
  })
})
