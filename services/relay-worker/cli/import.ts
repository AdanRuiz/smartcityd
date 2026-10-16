// Imports snapshot files into the relay without contacting any other relay (NFR-4, docs/spec/01 "Arrancar un
// relay nuevo"). Verifies them as docs/spec/06 asks (SNAP-6), runs the acceptance of docs/spec/07 without the
// limits for clients (RELAY-5) over a local copy, and writes a SQL file for `wrangler d1 execute DB --file`.
//
//   pnpm --filter relay-worker snapshot:import [--snapshot <event.json>]... [--out import.sql] <file.ndjson[.gz]>...
//
// A `--snapshot` is the signed `snapshot` event of one of the files, matched by `file.name`. Policy variables
// (CITIES, WRITE_POLICY, TRUST_ANCHORS, POW_BITS_REPORT) are read from the environment, as in wrangler.toml.

import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { parseArgs } from 'node:util'
import { gunzipSync } from 'node:zlib'
import { NOSTR_KIND } from '@smartcity/schemas'
import { readConfig, type RelayVars } from '../src/config.js'
import { checkStructure, type NostrEvent } from '../src/event.js'
import { checkSnapshotFile, importNdjson } from '../src/import.js'
import { RoleBook } from '../src/roles.js'
import { sqlFileDb } from '../src/sql.js'
import { Store } from '../src/store.js'
import { sqliteDb } from './sqlite.js'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    snapshot: { type: 'string', multiple: true, default: [] },
    out: { type: 'string', default: 'import.sql' },
  },
})
if (positionals.length === 0) {
  console.error('usage: snapshot:import [--snapshot <event.json>]... [--out import.sql] <file.ndjson[.gz]>...')
  process.exit(2)
}

function snapshotEvent(path: string): NostrEvent {
  const event = checkStructure(JSON.parse(readFileSync(path, 'utf8')))
  if (typeof event === 'string') throw new Error(`${path}: ${event}`)
  return event
}

function fileName(snapshot: NostrEvent): string | null {
  try {
    const name = (JSON.parse(snapshot.content) as { file?: { name?: unknown } }).file?.name
    return typeof name === 'string' ? name : null
  } catch {
    return null
  }
}

const snapshots = values.snapshot.map(snapshotEvent)
const config = readConfig(process.env as RelayVars)
// The local copy starts empty: its job is to resolve duplicates, DATA-3 and roles across the files imported.
const local = sqliteDb(new URL('../../../migrations/', import.meta.url))
const now = Math.floor(Date.now() / 1000)
const deps = { store: new Store(local.db), config, now: () => now, roles: new RoleBook(config.trustAnchors) }

const stored: NostrEvent[] = []
let failed = false
for (const path of positionals) {
  const file = new Uint8Array(readFileSync(path))
  const ndjson = new TextDecoder().decode(path.endsWith('.gz') ? gunzipSync(file) : file)
  const snapshot = snapshots.find((s) => fileName(s) === basename(path))
  if (snapshot) {
    const problem = await checkSnapshotFile(file, ndjson, snapshot)
    if (problem) {
      console.error(`${path}: not imported, ${problem}`)
      failed = true
      continue
    }
  } else {
    console.warn(`${path}: no --snapshot names this file; x is not checked, every event is still verified`)
  }
  const report = await importNdjson(ndjson, deps)
  stored.push(...report.stored)
  console.log(
    `${path}: ${report.stored.length} new, ${report.duplicates} duplicates, ${report.skipped} ephemeral skipped, ` +
      `${report.invalid.length} invalid`,
  )
  for (const { line, id, reason } of report.invalid) console.warn(`  line ${line} ${id}: ${reason}`)
}

// The snapshot events go too: retention needs them to purge what was imported (RELAY-4).
const announced = await importNdjson(snapshots.map((s) => JSON.stringify(s)).join('\n'), deps)
stored.push(...announced.stored)
for (const { id, reason } of announced.invalid) console.warn(`snapshot ${id}: ${reason}`)

// Deletions last, so they also remove the events of other files that they refer to.
const isDeletion = (e: NostrEvent) => e.kind === NOSTR_KIND.DELETION
const ordered = [...stored.filter((e) => !isDeletion(e)), ...stored.filter(isDeletion)]
const sql = sqlFileDb()
const target = new Store(sql.db)
writeFileSync(values.out, sql.toSql(ordered.flatMap((e) => target.importStatements(e, now))))
console.log(`${ordered.length} events written to ${values.out}. Apply with:`)
console.log(`  npx wrangler d1 execute DB --file ${values.out} [--local | --remote] [--env b]`)
if (failed) process.exitCode = 1
