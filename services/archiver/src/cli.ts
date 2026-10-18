#!/usr/bin/env node
// Entry point of the archiver CLI (docs/spec/06).
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { decrypt } from 'nostr-tools/nip49'
import { runPublish, type PublishDeps } from './publish.js'
import { runAddendum, runSnapshot } from './snapshot.js'
import { DEFAULT_CALENDARS, runStamp } from './stamp.js'
import { runUpgrade } from './upgrade.js'

const USAGE = [
  'usage: archiver snapshot|addendum --city <city> --day <YYYY-MM-DD> --relay <url> [--relay <url>…] [--out <dir>]',
  '         [--web-seed <base url>…] [--tracker <url>…] [--publish --key <ncryptsec file>]',
  '       archiver publish <file.snapshot.json>… --relay <url>… --key <ncryptsec file>',
  '       archiver stamp <file.snapshot.signed.json>… [--calendar <url>…]',
  '       archiver upgrade <file.snapshot.ots>… [--calendar <url>…]',
].join('\n')

/** The passphrase of the key: SC_PASSPHRASE, as in `packages/sdk/scripts/city.mjs`, or asked without echo. */
async function passphrase(prompt: string): Promise<string> {
  if (process.env.SC_PASSPHRASE) return process.env.SC_PASSPHRASE
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true })
  const muted = rl as unknown as { _writeToOutput: (s: string) => void }
  muted._writeToOutput = (s) => {
    if (s.startsWith(prompt)) process.stderr.write(prompt)
  }
  const answer = await new Promise<string>((resolve) => rl.question(prompt, resolve))
  rl.close()
  process.stderr.write('\n')
  return answer
}

/** The archiver's own NIP-49 key (ID-4), opened only when an event has to be signed. */
function keyFrom(path: string | undefined): PublishDeps['secretKey'] {
  return async () => {
    if (!path) throw new Error('--key <ncryptsec file> is needed to sign the snapshot event')
    const ncryptsec = (await readFile(path, 'utf8')).trim()
    const pass = await passphrase('Frase de la llave del archivista: ')
    try {
      return decrypt(ncryptsec, pass)
    } catch {
      throw new Error(`${path}: wrong passphrase or not an ncryptsec key`)
    }
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  const perFile = command === 'publish' || command === 'stamp' || command === 'upgrade'
  if (command !== 'snapshot' && command !== 'addendum' && !perFile) {
    console.error(USAGE)
    return 2
  }
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: perFile,
    options: {
      city: { type: 'string' },
      day: { type: 'string' },
      relay: { type: 'string', multiple: true },
      out: { type: 'string', default: '.' },
      'web-seed': { type: 'string', multiple: true },
      tracker: { type: 'string', multiple: true },
      publish: { type: 'boolean', default: false },
      key: { type: 'string' },
      calendar: { type: 'string', multiple: true },
    },
  })
  const log = (line: string) => console.error(line)
  const relays = values.relay ?? []
  const publishDeps = (): PublishDeps => ({
    fetch: (url, init) => fetch(url, init),
    now: Math.floor(Date.now() / 1000),
    secretKey: keyFrom(values.key),
    log,
  })

  if (perFile) {
    if (positionals.length === 0) {
      console.error(USAGE)
      return 2
    }
    const calendars = values.calendar ?? DEFAULT_CALENDARS
    let failed = 0
    for (const event of positionals) {
      try {
        if (command === 'publish') await runPublish({ event, relays }, publishDeps())
        else if (command === 'stamp') {
          await runStamp({ event, calendars }, { fetch: (url, init) => fetch(url, init), random: randomBytes, log })
        } else await runUpgrade({ ots: event, calendars }, { fetch: (url, init) => fetch(url, init), log })
      } catch (error) {
        log(`${event}: ${error instanceof Error ? error.message : String(error)}`)
        failed++
      }
    }
    return failed === 0 ? 0 : 1
  }

  if (!values.city || !values.day || (values.publish && !values.key)) {
    console.error(USAGE)
    return 2
  }
  const run = command === 'snapshot' ? runSnapshot : runAddendum
  const result = await run(
    {
      city: values.city,
      day: values.day,
      relays,
      out: values.out,
      webSeeds: values['web-seed'] ?? [],
      trackers: values.tracker,
    },
    { fetch: (url, init) => fetch(url, init), now: Math.floor(Date.now() / 1000), log },
  )
  // `--publish` signs and sends the event to the same relays it read (docs/spec/06, "Dónde corre el archivista").
  if (values.publish && result.files) await runPublish({ event: result.files.event, relays }, publishDeps())
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
