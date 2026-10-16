// Abre la app en un Chrome sin interfaz, espera en tiempo real y reporta errores de consola, violaciones de CSP,
// el estado de los relays y una captura. Sirve para comprobar APP-2 (file://) y NFR-1 en un navegador de verdad.
// Uso: node scripts/browser-check.mjs [url] [--wait 12] [--shot salida.png] [--eval "expresión JS"]
// Por defecto abre dist/index.html por file://. CHROME=<ruta> si Chrome no está en el lugar habitual.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const url = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')) ?? pathToFileURL(resolve('dist/index.html')).href
const waitS = Number(opt('--wait', 12))
const shot = opt('--shot', null)
const evalExpr = opt('--eval', null)

const candidates = [
  process.env.CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean)
const chrome = candidates.find((p) => existsSync(p))
if (!chrome) throw new Error('Chrome not found: set CHROME')

const profile = mkdtempSync(join(tmpdir(), 'sc-check-'))
const port = 9300 + Math.floor(Math.random() * 500)
const proc = spawn(chrome, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1280,800', 'about:blank',
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let target
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200)
  target = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).then((l) => l.find((t) => t.type === 'page')).catch(() => null)
}
if (!target) throw new Error('cannot reach Chrome DevTools')

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let nextId = 1
const waiting = new Map()
const logs = []
ws.addEventListener('message', ({ data }) => {
  const msg = JSON.parse(data)
  if (msg.id && waiting.has(msg.id)) return waiting.get(msg.id)(msg), waiting.delete(msg.id)
  if (msg.method === 'Runtime.consoleAPICalled') logs.push(`console.${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`)
  if (msg.method === 'Runtime.exceptionThrown') logs.push(`exception: ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`)
  if (msg.method === 'Log.entryAdded') logs.push(`${msg.params.entry.level}: ${msg.params.entry.text}`)
})
const send = (method, params = {}) =>
  new Promise((r) => {
    const id = nextId++
    waiting.set(id, r)
    ws.send(JSON.stringify({ id, method, params }))
  })

await send('Runtime.enable')
await send('Log.enable')
await send('Page.enable')
await send('Page.navigate', { url })
await sleep(waitS * 1000)

const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value
const report = {
  url,
  title: await evaluate('document.title'),
  header: await evaluate("document.querySelector('header')?.innerText"),
  panel: await evaluate("document.querySelector('.panel')?.innerText"),
  mapCanvas: await evaluate("!!document.querySelector('.maplibregl-canvas')"),
  custom: evalExpr ? await evaluate(evalExpr) : undefined,
}
if (shot) {
  const { result } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(shot, Buffer.from(result.data, 'base64'))
}
console.log(JSON.stringify(report, null, 2))
console.log(logs.length ? logs.join('\n') : '(no console messages)')
ws.close()
proc.kill()
await sleep(300)
try {
  rmSync(profile, { recursive: true, force: true })
} catch {
  // Chrome may still hold files on Windows
}
const problems = logs.filter((l) => /^(exception|error|console\.error)|Content Security Policy|Refused/.test(l))
process.exit(problems.length ? 1 : 0)
