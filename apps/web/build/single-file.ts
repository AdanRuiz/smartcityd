import { createHash } from 'node:crypto'
import { SINGLE_FILE, VARIANT_META } from '../src/variant'

export { SINGLE_FILE }

/** Marks the single-file variant, so the app does not register the Service Worker (APP-4). */
export const SINGLE_FILE_META = `<meta name="${VARIANT_META}" content="single-file" />`

// SEC-2. `worker-src blob:` because the map, signature and proof-of-work workers start from in-memory code (works from
// file://); 'self' for the Service Worker.
// `ws:` only for a relay on this machine during development.
export const CSP: readonly string[] = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "worker-src 'self' blob:",
  "child-src blob:",
  "connect-src 'self' wss: https: ws://localhost:* ws://127.0.0.1:* data: blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
]

const CSP_META = /<meta http-equiv="Content-Security-Policy" content="[^"]*" \/>/
const SCRIPT = /[ \t]*<script defer src="\.\/([^"]+)"><\/script>\n?/
const STYLE = /[ \t]*<link rel="stylesheet" href="\.\/([^"]+)">\n?/

const sha256 = (text: string) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`

/**
 * SEC-2 for the single file: the inline script and stylesheet are allowed by their hash, never with 'unsafe-inline'.
 * No 'self' for workers: there is no Service Worker to register.
 */
export function singleFileCsp(script: string, style: string): string {
  return CSP.map((directive) => {
    if (directive.startsWith('script-src ')) return `script-src ${sha256(script)}`
    if (directive.startsWith('style-src ')) return `style-src ${sha256(style)}`
    if (directive.startsWith('worker-src ')) return 'worker-src blob:'
    return directive
  }).join('; ')
}

/**
 * APP-4: `smartcity.html`, the whole app in one file that opens with a double click (from a torrent, a USB stick or an
 * email). Takes the built `index.html`, which loads one classic script and one stylesheet (APP-2), and puts both
 * inside it. The script goes at the end of `<body>`: an inline script cannot be deferred.
 * `read` returns the content of a file of the build by its relative path.
 */
export function singleFileHtml(html: string, read: (path: string) => string | undefined): string {
  const scriptTag = SCRIPT.exec(html)
  const styleTag = STYLE.exec(html)
  if (!scriptTag?.[1] || !styleTag?.[1]) throw new Error('single file: index.html must load one script and one stylesheet')
  if (SCRIPT.test(html.replace(SCRIPT, '')) || STYLE.test(html.replace(STYLE, ''))) {
    throw new Error('single file: index.html loads more than one script or stylesheet')
  }
  const js = read(scriptTag[1])
  const css = read(styleTag[1])
  if (js === undefined || css === undefined) throw new Error(`single file: missing ${js === undefined ? scriptTag[1] : styleTag[1]}`)

  // In <script> and <style> the HTML parser only looks for the closing tag. `</script` is escaped as `<\/script`,
  // which means the same in strings, templates and regular expressions; `<!--` and `</style` have no safe rewrite.
  const script = js.replace(/<\/(script)/gi, '<\\/$1')
  if (script.includes('<!--')) throw new Error('single file: the script contains "<!--"')
  if (/<\/style/i.test(css)) throw new Error('single file: the stylesheet contains "</style"')

  if (!CSP_META.test(html)) throw new Error('single file: index.html has no Content-Security-Policy')
  const csp = `<meta http-equiv="Content-Security-Policy" content="${singleFileCsp(script, css)}" />`
  const shell = html.replace(CSP_META, `${csp}\n    ${SINGLE_FILE_META}`).replace(SCRIPT, '').replace(STYLE, '')
  // Positions in the shell, before inserting code that could contain the same tags.
  const head = shell.indexOf('</head>')
  const body = shell.lastIndexOf('</body>')
  if (head < 0 || body < head) throw new Error('single file: index.html has no </head> or </body>')
  return (
    `${shell.slice(0, head)}  <style>${css}</style>\n  ` +
    `${shell.slice(head, body)}  <script>${script}</script>\n  ` +
    shell.slice(body)
  )
}
