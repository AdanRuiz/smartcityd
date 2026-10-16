import { describe, expect, it } from 'vitest'
import {
  ALLOWED_KINDS,
  KIND,
  NOSTR_KIND,
  checkValues,
  formatAddress,
  isCityId,
  kindClass,
  parseAddress,
  validateEvent,
  type DatasetContent,
  type EventToValidate,
} from '../src/index.js'

const PK_A = '9f3c'.padEnd(64, 'a')
const PK_B = '4be1'.padEnd(64, 'b')
const HASH = 'c'.repeat(64)
const HASH_2 = 'd'.repeat(64)
const CITY = 'mx-gdl'
const AIR = `${KIND.DATASET}:${PK_A}:air-quality`
const SOURCE = `${KIND.SOURCE}:${PK_B}:azotea-chapalita-01`
const G = [
  ['g', '9ewm'],
  ['g', '9ewmq'],
  ['g', '9ewmqx'],
]

type TestEvent = EventToValidate & { tags: string[][] }

const ev = (kind: number, tags: string[][], content: unknown): TestEvent => ({
  kind,
  tags,
  content: typeof content === 'string' ? content : JSON.stringify(content),
})

const airFields: DatasetContent['fields'] = {
  pm25: { type: 'number', unit: 'ug/m3', min: 0, max: 1000 },
  pm10: { type: 'number', unit: 'ug/m3', min: 0, max: 2000 },
  temp: { type: 'number', unit: 'Cel' },
  rh: { type: 'number', unit: '%', min: 0, max: 100 },
}

// One valid event per kind. The dataset and observation are the examples of docs/spec/03 verbatim.
const valid = {
  city: ev(KIND.CITY, [['d', CITY]], {
    v: 1,
    name: 'Guadalajara',
    bbox: [20.55, -103.47, 20.78, -103.24],
    tz: 'America/Mexico_City',
    relays: ['wss://relay-a.example', 'wss://relay-b.example'],
    roots: [PK_A],
    tiles: { x: HASH, urls: ['https://example.org/gdl.pmtiles'] },
  }),
  dataset: ev(
    KIND.DATASET,
    [
      ['d', 'air-quality'],
      ['c', '*'],
      ['t', 'ambiente'],
    ],
    '{"v":1,"name":"Calidad del aire","license":"CC0-1.0","mode":"observation","geometry":"point","cadence_s":300,"fields":{"pm25":{"type":"number","unit":"ug/m3","min":0,"max":1000},"pm10":{"type":"number","unit":"ug/m3","min":0,"max":2000},"temp":{"type":"number","unit":"Cel"},"rh":{"type":"number","unit":"%","min":0,"max":100}}}',
  ),
  source: ev(KIND.SOURCE, [['d', 'azotea-chapalita-01'], ['c', CITY], ['a', AIR], ...G], {
    v: 1,
    name: 'Azotea Chapalita',
    loc: [20.6668, -103.3918],
    status: 'active',
    keys: [PK_B],
  }),
  observation: ev(
    KIND.OBSERVATION,
    [['c', CITY], ['a', AIR], ['a', SOURCE], ...G],
    '{"v":1,"loc":[20.6668,-103.3918],"obs":[{"ts":1760000000,"values":{"pm25":18.2,"temp":24.1}},{"ts":1760000300,"values":{"pm25":19.0,"temp":24.0}}]}',
  ),
  state: ev(KIND.STATE, [['d', 'parking-centro'], ['c', CITY], ['a', `${KIND.DATASET}:${PK_A}:parking`], ...G], {
    v: 1,
    ts: 1760000000,
    values: { free: 42, total: 120 },
    loc: [20.6668, -103.3918],
  }),
  live: ev(KIND.LIVE, [['d', 'bus-142'], ['c', CITY], ['a', `${KIND.DATASET}:${PK_A}:buses`], ...G], {
    v: 1,
    ts: 1760000000,
    values: { route: '380', speed: 31 },
    loc: [20.6668, -103.3918],
  }),
  report: ev(KIND.REPORT, [['c', CITY], ['t', 'bache'], ...G], {
    v: 1,
    title: 'Bache profundo',
    loc: [20.67, -103.39],
    attachments: [{ x: HASH, mime: 'image/jpeg', size: 204800, urls: ['https://relay.example/v1/blob/' + HASH] }],
  }),
  report_update: ev(
    KIND.REPORT_UPDATE,
    [
      ['c', CITY],
      ['e', HASH],
      ['p', PK_B],
    ],
    { v: 1, status: 'resolved', body: 'Reparado' },
  ),
  app: ev(
    KIND.APP,
    [
      ['d', 'aire-bot'],
      ['c', CITY],
      ['a', AIR],
    ],
    { v: 1, name: 'Aire Bot', urls: ['https://example.org'], writes: [AIR], reads: [KIND.OBSERVATION], automated: true },
  ),
  roles: ev(
    KIND.ROLES,
    [
      ['d', CITY],
      ['c', CITY],
      ['p', PK_A, 'authority', 'Ayuntamiento'],
      ['p', PK_B, 'archiver'],
    ],
    { v: 1 },
  ),
  release: ev(
    KIND.RELEASE,
    [
      ['d', 'smartcity:stable'],
      ['x', HASH],
    ],
    {
      v: 1,
      version: '1.4.0',
      commit: '2711bd6',
      single: { x: HASH, size: 1832044, urls: ['https://example.org/smartcity.html'] },
      dist: { cid: 'bafyexample', magnet: 'magnet:?xt=urn:btih:abc&ws=https://example.org/' },
      mirrors: ['https://smartcity.pages.dev'],
    },
  ),
  snapshot: ev(
    KIND.SNAPSHOT,
    [
      ['c', CITY],
      ['t', 'daily'],
      ['x', HASH],
    ],
    {
      v: 1,
      from: 1759968000,
      to: 1760054400,
      count: 48211,
      format: 'ndjson+gzip',
      x: HASH,
      file: { name: 'sc_mx-gdl_2026-10-09.ndjson.gz', x: HASH_2, size: 9320114 },
      magnet: 'magnet:?xt=urn:btih:abc&ws=https://example.org/',
      urls: ['https://example.org/sc_mx-gdl_2026-10-09.ndjson.gz'],
      relays: ['wss://relay-a.example'],
      policy: 'none',
    },
  ),
} satisfies Record<string, TestEvent>

type Name = keyof typeof valid

// Variants of a valid event: change the content, the tags, or both.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the point is to build ill-typed content
function vary(name: Name, change: { content?: (c: Record<string, any>) => void; tags?: (t: string[][]) => string[][] }) {
  const base = valid[name]
  const content = JSON.parse(base.content)
  change.content?.(content)
  const tags = base.tags.map((t) => [...t])
  return ev(base.kind, change.tags ? change.tags(tags) : tags, content)
}

const without = (name: string) => (tags: string[][]) => tags.filter((t) => t[0] !== name)
const replace = (name: string, value: string) => (tags: string[][]) =>
  tags.map((t) => (t[0] === name ? [name, value, ...t.slice(2)] : t))

describe('valid events', () => {
  it.each(Object.entries(valid))('%s passes', (_name, event) => {
    expect(validateEvent(event)).toMatchObject({ ok: true })
  })

  it('ignores unknown content fields (EVT-6)', () => {
    expect(validateEvent(vary('observation', { content: (c) => (c.extra = { anything: true }) })).ok).toBe(true)
  })

  it('accepts an observation without loc and without g tags (geometry: none)', () => {
    const event = vary('observation', { content: (c) => delete c.loc, tags: without('g') })
    expect(validateEvent(event).ok).toBe(true)
  })

  it('accepts a report_update with only a body (comment)', () => {
    expect(validateEvent(vary('report_update', { content: (c) => delete c.status })).ok).toBe(true)
  })
})

describe('counterexamples', () => {
  const cases: [string, EventToValidate][] = [
    ['content that is not JSON', ev(KIND.OBSERVATION, valid.observation.tags, 'pm25=18')],
    ['content that is not an object', ev(KIND.OBSERVATION, valid.observation.tags, '[1]')],
    ['missing v (DATA-5)', vary('observation', { content: (c) => delete c.v })],
    ['non-integer v', vary('observation', { content: (c) => (c.v = '1') })],
    ['unsupported v', vary('observation', { content: (c) => (c.v = 2) })],
    ['kind without schema', ev(1, [], { v: 1 })],

    ['observation without obs', vary('observation', { content: (c) => delete c.obs })],
    ['observation with empty obs', vary('observation', { content: (c) => (c.obs = []) })],
    [
      'observation with more than 500 readings',
      vary('observation', { content: (c) => (c.obs = Array(501).fill(c.obs[0])) }),
    ],
    ['reading without ts', vary('observation', { content: (c) => delete c.obs[0].ts })],
    ['reading with fractional ts (EVT-5)', vary('observation', { content: (c) => (c.obs[0].ts = 1760000000.5) })],
    ['reading with empty values', vary('observation', { content: (c) => (c.obs[0].values = {}) })],
    ['nested value', vary('observation', { content: (c) => (c.obs[0].values.pm25 = { n: 1 }) })],
    ['null value', vary('observation', { content: (c) => (c.obs[0].values.pm25 = null) })],
    ['text value over 256 chars (EVT-9)', vary('observation', { content: (c) => (c.obs[0].values.note = 'x'.repeat(257)) })],
    [
      'more than 64 values (EVT-9)',
      vary('observation', {
        content: (c) => (c.obs[0].values = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`f${i}`, i]))),
      }),
    ],
    ['unknown quality flag', vary('observation', { content: (c) => (c.obs[0].q = 'great') })],
    ['latitude out of range', vary('observation', { content: (c) => (c.loc = [91, 0]) })],
    ['loc in [lon, lat] order out of range (EVT-4)', vary('observation', { content: (c) => (c.loc = [-103.3918, 220.6668]) })],
    ['loc with three components', vary('observation', { content: (c) => (c.loc = [20.6, -103.3, 1500]) })],
    ['loc with more than 6 decimals (EVT-4)', vary('observation', { content: (c) => (c.loc = [20.66680001, -103.3918]) })],
    ['reading loc with more than 6 decimals', vary('observation', { content: (c) => (c.obs[0].loc = [20.1234567, -103.39]) })],

    ['observation without city', vary('observation', { tags: without('c') })],
    ['observation with malformed city id (EVT-1)', vary('observation', { tags: replace('c', 'Guadalajara') })],
    ['observation with wildcard city', vary('observation', { tags: replace('c', '*') })],
    ['observation without dataset', vary('observation', { tags: without('a') })],
    ['observation with truncated dataset address', vary('observation', { tags: replace('a', `${KIND.DATASET}:9f3c:air`) })],
    ['observation with loc but no g tags (EVT-3)', vary('observation', { tags: without('g') })],
    ['observation with a single g tag', vary('observation', { tags: (t) => t.filter((x) => x[1] !== '9ewm' && x[1] !== '9ewmq') })],
    [
      'g tags of different points',
      vary('observation', { tags: (t) => t.map((x) => (x[1] === '9ewmqx' ? ['g', '9ewmrx'] : x)) }),
    ],
    [
      'g tags with invalid geohash characters',
      vary('observation', { tags: (t) => t.map((x) => (x[0] === 'g' ? ['g', x[1]!.replace('9', 'a')] : x)) }),
    ],

    ['city without bbox', vary('city', { content: (c) => delete c.bbox })],
    ['city with 2-number bbox', vary('city', { content: (c) => (c.bbox = [20.5, -103.4]) })],
    ['city without roots', vary('city', { content: (c) => (c.roots = []) })],
    ['city with npub instead of hex root', vary('city', { content: (c) => (c.roots = ['npub1xyz']) })],
    ['city with https relay', vary('city', { content: (c) => (c.relays = ['https://relay.example']) })],
    ['city id in uppercase', vary('city', { tags: replace('d', 'MX-GDL') })],
    ['city id over 32 chars', vary('city', { tags: replace('d', 'mx-' + 'a'.repeat(30)) })],
    ['city without d', vary('city', { tags: without('d') })],

    ['dataset without license', vary('dataset', { content: (c) => delete c.license })],
    ['dataset with unknown mode', vary('dataset', { content: (c) => (c.mode = 'stream') })],
    ['dataset with unknown field type', vary('dataset', { content: (c) => (c.fields.pm25.type = 'float') })],
    ['dataset without fields', vary('dataset', { content: (c) => (c.fields = {}) })],
    ['dataset without category', vary('dataset', { tags: without('t') })],
    ['dataset with uppercase category', vary('dataset', { tags: replace('t', 'Ambiente') })],
    ['dataset without d', vary('dataset', { tags: without('d') })],

    ['source without status', vary('source', { content: (c) => delete c.status })],
    ['source with unknown status', vary('source', { content: (c) => (c.status = 'broken') })],
    ['source with invalid device key', vary('source', { content: (c) => (c.keys = ['abc']) })],
    ['source pointing at a non-dataset address', vary('source', { tags: replace('a', SOURCE) })],

    ['state without ts', vary('state', { content: (c) => delete c.ts })],
    ['state without d', vary('state', { tags: without('d') })],
    ['live without g tags', vary('live', { tags: without('g') })],

    ['report without title', vary('report', { content: (c) => delete c.title })],
    ['report with title over 120 chars', vary('report', { content: (c) => (c.title = 'x'.repeat(121)) })],
    ['report with body over 2000 chars', vary('report', { content: (c) => (c.body = 'x'.repeat(2001)) })],
    ['report without loc', vary('report', { content: (c) => delete c.loc })],
    ['report with 5 attachments', vary('report', { content: (c) => (c.attachments = Array(5).fill(c.attachments[0])) })],
    ['attachment without hash', vary('report', { content: (c) => delete c.attachments[0].x })],
    ['attachment with javascript: url', vary('report', { content: (c) => (c.attachments[0].urls = ['javascript:alert(1)']) })],
    ['attachment inlined as data: url (DATA-11)', vary('report', { content: (c) => (c.attachments[0].urls = ['data:image/png;base64,AAAA']) })],
    ['report without category', vary('report', { tags: without('t') })],
    ['report without g tags', vary('report', { tags: without('g') })],

    ['report_update with neither status nor body', vary('report_update', { content: (c) => (delete c.status, delete c.body) })],
    ['report_update with unknown status', vary('report_update', { content: (c) => (c.status = 'closed') })],
    ['report_update without e', vary('report_update', { tags: without('e') })],
    ['report_update without p', vary('report_update', { tags: without('p') })],
    ['report_update with malformed e', vary('report_update', { tags: replace('e', 'abc') })],

    ['app without writes', vary('app', { content: (c) => delete c.writes })],
    ['app with malformed dataset address', vary('app', { tags: replace('a', 'air-quality') })],

    ['roles with unknown role', vary('roles', { tags: (t) => [...t, ['p', PK_B, 'admin']] })],
    ['roles with p tag without role', vary('roles', { tags: (t) => [...t, ['p', PK_B]] })],
    ['roles with malformed pubkey', vary('roles', { tags: (t) => [...t, ['p', 'abc', 'operator']] })],
    ['roles whose c differs from d', vary('roles', { tags: replace('c', 'mx-mty') })],

    ['release without single', vary('release', { content: (c) => delete c.single })],
    ['release whose x tag differs from single.x', vary('release', { tags: replace('x', HASH_2) })],
    ['release with unknown channel', vary('release', { tags: replace('d', 'smartcity:nightly') })],
    ['release without channel', vary('release', { tags: replace('d', 'smartcity') })],

    ['snapshot without count', vary('snapshot', { content: (c) => delete c.count })],
    ['snapshot without policy (SNAP-3)', vary('snapshot', { content: (c) => delete c.policy })],
    ['snapshot without file hash', vary('snapshot', { content: (c) => delete c.file.x })],
    ['snapshot with unknown type', vary('snapshot', { tags: replace('t', 'weekly') })],
    ['snapshot whose x tag differs from content x', vary('snapshot', { tags: replace('x', HASH_2) })],
    ['snapshot without x tag', vary('snapshot', { tags: without('x') })],
  ]

  it.each(cases)('%s fails', (_name, event) => {
    const result = validateEvent(event)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.length).toBeGreaterThan(0)  })

  it('counts title length in characters, not UTF-16 units', () => {
    expect(validateEvent(vary('report', { content: (c) => (c.title = '🕳️'.repeat(60)) })).ok).toBe(true)
  })
})

describe('checkValues (EVT-8)', () => {
  it('accepts values that match the dataset fields', () => {
    expect(checkValues(airFields, { pm25: 18.2, temp: 24.1 })).toEqual([])
  })

  it.each([
    ['unknown field', { no2: 4 }],
    ['wrong type', { pm25: '18.2' }],
    ['below min', { pm25: -1 }],
    ['above max', { rh: 101 }],
    ['inherited property name', { constructor: 1 }],
  ])('rejects %s', (_name, values) => {
    expect(checkValues(airFields, values)).toHaveLength(1)
  })

  it('checks integer and enum fields', () => {
    const fields: DatasetContent['fields'] = { free: { type: 'integer', min: 0 }, level: { type: 'string', enum: ['low', 'high'] } }
    expect(checkValues(fields, { free: 42, level: 'low' })).toEqual([])
    expect(checkValues(fields, { free: 4.5 })).toHaveLength(1)
    expect(checkValues(fields, { level: 'medium' })).toHaveLength(1)
  })
})

describe('kinds and addresses', () => {
  it('classifies kinds as NIP-01 does', () => {
    expect(kindClass(KIND.OBSERVATION)).toBe('regular')
    expect(kindClass(KIND.LIVE)).toBe('ephemeral')
    expect(kindClass(KIND.CITY)).toBe('addressable')
    expect(kindClass(NOSTR_KIND.DELETION)).toBe('regular')
    expect(kindClass(NOSTR_KIND.RELAY_LIST)).toBe('replaceable')
  })

  it('allows the 12 system kinds plus the 5 reused ones', () => {
    expect(new Set(ALLOWED_KINDS).size).toBe(17)
  })

  it('round-trips addresses, including a d with colons', () => {
    const address = { kind: KIND.RELEASE, pubkey: PK_A, d: 'smartcity:stable' }
    expect(parseAddress(formatAddress(address))).toEqual(address)
    expect(parseAddress('31481:9f3c:air-quality')).toBeNull()
  })

  it('validates city ids (EVT-1)', () => {
    expect(isCityId('mx-gdl')).toBe(true)
    expect(isCityId('mx-')).toBe(false)
    expect(isCityId('gdl')).toBe(false)
    expect(isCityId('mx-gdl_centro')).toBe(false)
  })
})
