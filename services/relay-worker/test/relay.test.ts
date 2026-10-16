import { KIND } from '@smartcity/schemas'
import { describe, expect, it } from 'vitest'
import { isNew } from '../src/accept.js'
import { filterFromQuery, matchFilter, parseFilter, type Filter } from '../src/filter.js'
import { CITY, NOW, airDataset, dataset, deletion, key, live, observation, relay, report, roles, sign } from './helpers.js'

const message = (r: { message: string }) => r.message

describe('acceptance (docs/spec/07)', () => {
  it('accepts a valid observation and stores the event and its indexed tags (test 1)', async () => {
    const r = relay()
    const { sk, pk } = key()
    const result = await r.publish(observation(sk, pk))
    expect(result).toMatchObject({ ok: true, status: 'stored', message: '' })
    expect(isNew(result)).toBe(true)
    expect(r.count('SELECT count(*) AS n FROM events')).toBe(1)
    // a + three g; c goes into the city column.
    expect(r.count('SELECT count(*) AS n FROM tags')).toBe(4)
    expect(r.count(`SELECT count(*) AS n FROM events WHERE city = '${CITY}'`)).toBe(1)
  })

  it('answers OK true with duplicate: for the same event, without a new row (test 2)', async () => {
    const r = relay()
    const { sk, pk } = key()
    const event = observation(sk, pk)
    await r.publish(event)
    const again = await r.publish(event)
    expect(again).toMatchObject({ ok: true, status: 'duplicate' })
    expect(message(again)).toMatch(/^duplicate:/)
    expect(isNew(again)).toBe(false)
    expect(r.count('SELECT count(*) AS n FROM events')).toBe(1)
  })

  describe('rejections with the right prefix (test 3)', () => {
    it('altered signature', async () => {
      const { sk, pk } = key()
      const event = observation(sk, pk)
      const sig = (event.sig[0] === '0' ? '1' : '0') + event.sig.slice(1)
      expect(message(await relay().publish({ ...event, sig }))).toBe('invalid: bad signature')
    })

    it('altered content (the id no longer matches)', async () => {
      const { sk, pk } = key()
      const event = observation(sk, pk)
      const result = await relay().publish({ ...event, content: event.content.replace('18.2', '99') })
      expect(message(result)).toBe('invalid: id does not match the event')
    })

    it('invalid schema', async () => {
      const { sk, pk } = key()
      const event = sign(sk, KIND.OBSERVATION, [['c', CITY], ['a', airDataset(pk)]], { v: 1, obs: [] })
      expect(message(await relay().publish(event))).toMatch(/^invalid: content/)
    })

    it('missing mandatory tags', async () => {
      const { sk } = key()
      const event = sign(sk, KIND.OBSERVATION, [['c', CITY]], { v: 1, obs: [{ ts: NOW, values: { pm25: 1 } }] })
      expect(message(await relay().publish(event))).toMatch(/^invalid: .*dataset address/)
    })

    it('date more than 15 minutes in the future (DATA-4)', async () => {
      const { sk, pk } = key()
      expect(message(await relay().publish(observation(sk, pk, NOW + 16 * 60)))).toMatch(/^invalid: .*future/)
      expect((await relay().publish(observation(sk, pk, NOW + 14 * 60))).ok).toBe(true)
    })

    it('kind outside the system', async () => {
      const { sk } = key()
      expect(message(await relay().publish(sign(sk, 1, [], 'hola')))).toMatch(/^blocked:/)
    })

    it('malformed structure and oversized events', async () => {
      const { sk, pk } = key()
      const event = observation(sk, pk)
      expect(message(await relay().publish({ ...event, id: 'xyz' }))).toMatch(/^invalid: id/)
      expect(message(await relay().publish('not an event'))).toMatch(/^invalid:/)
      const big = sign(sk, KIND.REPORT, [['c', CITY], ['t', 'bache']], { v: 1, title: 'x'.repeat(70_000) })
      expect(message(await relay().publish(big))).toMatch(/^invalid: event larger than/)
    })

    it('regular events older than MAX_EVENT_AGE_DAYS; addressable ones of any age (RELAY-5)', async () => {
      const { sk, pk } = key()
      const old = NOW - 31 * 86_400
      expect(message(await relay().publish(observation(sk, pk, old)))).toBe('invalid: too old')
      expect((await relay({ MAX_EVENT_AGE_DAYS: '0' }).publish(observation(sk, pk, old))).ok).toBe(true)
      expect((await relay().publish(dataset(sk, 'Aire', old))).ok).toBe(true)
    })
  })

  it('rate-limits per pubkey before verifying the signature (RELAY-3)', async () => {
    const r = relay({ RATE_EVENTS_PER_MIN: '2' })
    const { sk, pk } = key()
    expect((await r.publish(observation(sk, pk, NOW - 1))).ok).toBe(true)
    expect((await r.publish(observation(sk, pk, NOW - 2))).ok).toBe(true)
    const third = observation(sk, pk, NOW - 3)
    expect(message(await r.publish({ ...third, sig: '0'.repeat(128) }))).toBe('rate-limited: slow down')
    const other = key()
    expect((await r.publish(observation(other.sk, other.pk))).ok).toBe(true)
  })

  it('restricts cities the operator does not serve (step 9)', async () => {
    const r = relay({ CITIES: 'mx-cdmx' })
    const { sk, pk } = key()
    expect(message(await r.publish(observation(sk, pk)))).toBe(`restricted: city ${CITY} is not served by this relay`)
    expect((await r.publish(dataset(sk, 'Aire'))).ok).toBe(true) // dataset for every city: c = *
  })

  it('does not store ephemeral events but delivers them', async () => {
    const r = relay()
    const { sk, pk } = key()
    const result = await r.publish(live(sk, pk))
    expect(result).toMatchObject({ ok: true, status: 'ephemeral' })
    expect(isNew(result)).toBe(true)
    expect(r.count('SELECT count(*) AS n FROM events')).toBe(0)
  })
})

describe('addressable events (test 4, DATA-3)', () => {
  it('a newer version replaces the stored one, tags included', async () => {
    const r = relay()
    const { sk, pk } = key()
    await r.publish(dataset(sk, 'v1', NOW - 100))
    const newer = dataset(sk, 'v2', NOW)
    expect(await r.publish(newer)).toMatchObject({ ok: true, status: 'replaced' })
    const stored = await r.store.query({ kinds: [KIND.DATASET], authors: [pk], tags: { d: ['air-quality'] } }, NOW)
    expect(stored.map((e) => e.id)).toEqual([newer.id])
    expect(r.count('SELECT count(*) AS n FROM tags')).toBe(1) // only the t of the new one
  })

  it('an older version is discarded as duplicate', async () => {
    const r = relay()
    const { sk } = key()
    const current = dataset(sk, 'v2', NOW)
    await r.publish(current)
    const older = await r.publish(dataset(sk, 'v1', NOW - 100))
    expect(older).toMatchObject({ ok: true, status: 'stale' })
    expect(message(older)).toMatch(/^duplicate:/)
    expect(r.count('SELECT count(*) AS n FROM events')).toBe(1)
  })

  it('on a tie of created_at the smaller id wins, whatever the arrival order', async () => {
    const { sk, pk } = key()
    const [a, b] = [dataset(sk, 'a'), dataset(sk, 'b')].sort((x, y) => (x.id < y.id ? -1 : 1))
    for (const order of [
      [a!, b!],
      [b!, a!],
    ]) {
      const r = relay()
      for (const event of order) await r.publish(event)
      const stored = await r.store.query({ authors: [pk], tags: {} }, NOW)
      expect(stored.map((e) => e.id)).toEqual([a!.id])
    }
  })
})

describe('deletion with kind 5 (test 5, DATA-8)', () => {
  it("the author's request deletes by id and by address", async () => {
    const r = relay()
    const { sk, pk } = key()
    const obs = observation(sk, pk)
    const ds = dataset(sk, 'Aire', NOW - 5)
    await r.publish(obs)
    await r.publish(ds)
    const del = deletion(sk, [
      ['e', obs.id],
      ['a', `${KIND.DATASET}:${pk}:air-quality`],
    ])
    expect(await r.publish(del)).toMatchObject({ ok: true, status: 'stored' })
    const left = await r.store.query({ authors: [pk], tags: {} }, NOW + 100)
    expect(left.map((e) => e.id)).toEqual([del.id])
    expect(r.count('SELECT count(*) AS n FROM tags WHERE event_id <> ' + `'${del.id}'`)).toBe(0)
  })

  it("another key's request deletes nothing", async () => {
    const r = relay()
    const author = key()
    const intruder = key()
    const obs = observation(author.sk, author.pk)
    await r.publish(obs)
    await r.publish(deletion(intruder.sk, [['e', obs.id], ['a', `${KIND.DATASET}:${author.pk}:air-quality`]]))
    expect((await r.store.query({ ids: [obs.id], tags: {} }, NOW)).length).toBe(1)
  })
})

describe('queries (test 6)', () => {
  async function populated() {
    const r = relay({ POW_BITS_REPORT: '0' })
    const a = key()
    const b = key()
    const events = [
      observation(a.sk, a.pk, NOW - 300),
      observation(a.sk, a.pk, NOW - 200, [['t', 'calibrated']]),
      observation(b.sk, a.pk, NOW - 100),
      observation(b.sk, b.pk, NOW - 50),
      dataset(a.sk, 'Aire', NOW - 400),
      sign(b.sk, KIND.REPORT, [['c', 'mx-cdmx'], ['t', 'bache'], ['g', '9g3w'], ['g', '9g3wq'], ['g', '9g3wqx']], {
        v: 1,
        title: 'Bache',
        loc: [19.43, -99.13],
      }),
    ]
    for (const e of events) expect((await r.publish(e)).ok).toBe(true)
    return { r, a, b, events }
  }

  it('SQL and in-memory matching agree for every kind of condition', async () => {
    const { r, a, b, events } = await populated()
    const filters: Filter[] = [
      { tags: {} },
      { authors: [a.pk], tags: {} },
      { kinds: [KIND.OBSERVATION], since: NOW - 250, until: NOW - 60, tags: {} },
      { tags: { c: [CITY] } },
      { tags: { c: ['mx-cdmx'], t: ['bache'] } },
      { tags: { a: [airDataset(a.pk)] } },
      { tags: { a: [airDataset(a.pk)], g: ['9ewmq'] }, authors: [b.pk] },
      { tags: { t: ['calibrated', 'ambiente'] } },
      { tags: { d: ['air-quality'] }, kinds: [KIND.DATASET] },
      { ids: [events[0]!.id, events[3]!.id], tags: {} },
      { kinds: [KIND.OBSERVATION], limit: 2, tags: {} },
      { authors: [], tags: {} },
    ]
    for (const filter of filters) {
      const sql = (await r.store.query(filter, NOW)).map((e) => e.id)
      const memory = events
        .filter((e) => matchFilter(filter, e))
        .sort((x, y) => y.created_at - x.created_at)
        .slice(0, filter.limit ?? Infinity)
        .map((e) => e.id)
      expect(sql, JSON.stringify(filter)).toEqual(memory)
    }
  })

  it('GET /v1/events parameters and a REQ filter return the same set', async () => {
    const { r, a } = await populated()
    const params = new URLSearchParams({ kinds: `${KIND.OBSERVATION}`, c: CITY, a: airDataset(a.pk), limit: '10' })
    const fromQuery = filterFromQuery(params)
    const fromReq = parseFilter({ kinds: [KIND.OBSERVATION], '#c': [CITY], '#a': [airDataset(a.pk)], limit: 10 })
    expect(fromQuery).toEqual(fromReq)
    const result = await r.store.query(fromQuery as Filter, NOW)
    expect(result).toHaveLength(3)
  })

  it('does not return expired events (NIP-40)', async () => {
    const r = relay()
    const { sk, pk } = key()
    await r.publish(observation(sk, pk, NOW, [['expiration', `${NOW + 60}`]]))
    expect(await r.store.query({ tags: {} }, NOW)).toHaveLength(1)
    expect(await r.store.query({ tags: {} }, NOW + 61)).toHaveLength(0)
  })
})

describe('filters', () => {
  it('rejects tags without an index and filters too large for D1', () => {
    expect(parseFilter({ '#r': ['x'] })).toBe('unsupported: tag #r is not indexed')
    expect(parseFilter({ authors: ['abc'] })).toMatch(/hex/)
    expect(parseFilter({ '#g': Array.from({ length: 81 }, (_, i) => `${i}`) })).toMatch(/more than 80 values/)
    expect(filterFromQuery(new URLSearchParams({ foo: '1' }))).toBe('unknown parameter: foo')
  })
})

describe('proof of work and roles (step 8, step 9, SPAM-1, docs/spec/04)', () => {
  it('asks reports from keys without a role for the configured bits', async () => {
    const r = relay({ POW_BITS_REPORT: '8' })
    const { sk } = key()
    expect(message(await r.publish(report(sk)))).toBe('pow: difficulty 8 required')
    expect((await r.publish(report(sk, 8))).ok).toBe(true)
    // Other kinds need no work.
    expect((await r.publish(observation(sk, key().pk))).ok).toBe(true)
  })

  it('asks 16 bits by default and none when disabled', async () => {
    const { sk } = key()
    expect(message(await relay().publish(report(sk)))).toBe('pow: difficulty 16 required')
    expect((await relay({ POW_BITS_REPORT: '0' }).publish(report(sk))).ok).toBe(true)
  })

  it('does not ask keys with a role from an anchor, nor blocked ones a pass', async () => {
    const anchor = key()
    const official = key()
    const banned = key()
    const r = relay({ TRUST_ANCHORS: anchor.pk, POW_BITS_REPORT: '8' })
    expect((await r.publish(roles(anchor.sk, [[official.pk, 'operator'], [banned.pk, 'blocked']]))).ok).toBe(true)
    expect((await r.publish(report(official.sk))).ok).toBe(true)
    expect((await r.publish(report(anchor.sk, 0, NOW + 1))).ok).toBe(true)
    expect(message(await r.publish(report(banned.sk)))).toBe('pow: difficulty 8 required')
  })

  it('ignores roles lists from keys that are not anchors (TRUST-4)', async () => {
    const anchor = key()
    const impostor = key()
    const friend = key()
    const r = relay({ TRUST_ANCHORS: anchor.pk, POW_BITS_REPORT: '8' })
    expect((await r.publish(roles(impostor.sk, [[friend.pk, 'authority']]))).ok).toBe(true)
    expect(message(await r.publish(report(friend.sk)))).toBe('pow: difficulty 8 required')
  })

  it('with WRITE_POLICY=roles takes only anchors and keys with a role', async () => {
    const anchor = key()
    const source = key()
    const r = relay({ TRUST_ANCHORS: anchor.pk, WRITE_POLICY: 'roles' })
    expect(message(await r.publish(observation(source.sk, source.pk)))).toBe('restricted: this relay only accepts keys with a role')
    expect((await r.publish(roles(anchor.sk, [[source.pk, 'source']]))).ok).toBe(true)
    expect((await r.publish(observation(source.sk, source.pk))).ok).toBe(true)
  })

  it('rejects a roles policy without anchors and anchors that are not pubkeys', () => {
    expect(() => relay({ WRITE_POLICY: 'roles' })).toThrow(/TRUST_ANCHORS/)
    expect(() => relay({ TRUST_ANCHORS: 'npub1abc' })).toThrow(/not a hex pubkey/)
  })
})
