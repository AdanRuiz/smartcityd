#!/usr/bin/env node
// Entry point of the archiver CLI (docs/spec/06).
import { parseArgs } from 'node:util'
import { runAddendum, runSnapshot } from './snapshot.js'

const USAGE = 'usage: archiver snapshot|addendum --city <city> --day <YYYY-MM-DD> --relay <url> [--relay <url>…] [--out <dir>] [--web-seed <base url>…] [--tracker <url>…]'

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  if (command !== 'snapshot' && command !== 'addendum') {
    console.error(USAGE)
    return 2
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      city: { type: 'string' },
      day: { type: 'string' },
      relay: { type: 'string', multiple: true },
      out: { type: 'string', default: '.' },
      'web-seed': { type: 'string', multiple: true },
      tracker: { type: 'string', multiple: true },
    },
  })
  if (!values.city || !values.day) {
    console.error(USAGE)
    return 2
  }
  const run = command === 'snapshot' ? runSnapshot : runAddendum
  await run(
    {
      city: values.city,
      day: values.day,
      relays: values.relay ?? [],
      out: values.out,
      webSeeds: values['web-seed'] ?? [],
      trackers: values.tracker,
    },
    { fetch: (url, init) => fetch(url, init), now: Math.floor(Date.now() / 1000), log: (line) => console.error(line) },
  )
  // A relay that failed is already in the log; the snapshot was written, so the run succeeded.
  return 0
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    console.error(`archiver: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  },
)
