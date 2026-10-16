// strfry write-policy plugin (https://github.com/hoytech/strfry/blob/master/docs/plugins.md): the acceptance rules of
// the reference relay (docs/spec/07) that do not need a database. strfry itself checks NIP-01 structure, id and
// signature, size and duplicates; it stores and serves every event as a standard relay (ARCH-1).
import { createInterface } from 'node:readline'
import { decide, readPolicyConfig } from './rules.js'

const config = readPolicyConfig(process.env)
const lines = createInterface({ input: process.stdin, terminal: false })

lines.on('line', (line) => {
  let request: { type?: string; event?: unknown }
  try {
    request = JSON.parse(line)
  } catch {
    return
  }
  const event = request.event as { id?: unknown } | undefined
  const id = typeof event?.id === 'string' ? event.id : ''
  if (request.type !== 'new') {
    process.stdout.write(`${JSON.stringify({ id, action: 'accept' })}\n`)
    return
  }
  const reason = decide(request.event, config, Math.floor(Date.now() / 1000))
  process.stdout.write(`${JSON.stringify(reason ? { id, action: 'reject', msg: reason } : { id, action: 'accept' })}\n`)
})
