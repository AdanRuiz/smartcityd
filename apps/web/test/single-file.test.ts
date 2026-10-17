import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { CSP, SINGLE_FILE_META, singleFileHtml } from '../build/single-file'

// The index.html that the build writes (APP-2): one classic script and one stylesheet, CSP in <meta>.
const INDEX = `<!doctype html>
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${CSP.join('; ')}" />
    <title>SmartCity</title>
    <script defer src="./assets/app-1.js"></script>
    <link rel="stylesheet" href="./assets/style-1.css">
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`

const files = (js: string, css = 'body{margin:0}'): Record<string, string> => ({ 'assets/app-1.js': js, 'assets/style-1.css': css })
const build = (js: string, css?: string) => singleFileHtml(INDEX, (path) => files(js, css)[path])
const hash = (text: string) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`
const csp = (html: string) => /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1] ?? ''

describe('smartcity.html (APP-4)', () => {
  it('puts the script and the stylesheet inside the HTML and loads nothing else', () => {
    const html = build('document.title="ok"')
    expect(html).toContain('<style>body{margin:0}</style>')
    expect(html).toContain('<script>document.title="ok"</script>')
    expect(html).not.toMatch(/<script[^>]* src=|<link rel="stylesheet"/)
    // The inline script runs after #root exists.
    expect(html.indexOf('<div id="root">')).toBeLessThan(html.indexOf('<script>'))
    expect(html.indexOf('<style>')).toBeLessThan(html.indexOf('</head>'))
  })

  it('marks the variant, so the app does not register the Service Worker', () => {
    expect(build('1')).toContain(SINGLE_FILE_META)
  })

  it('allows the inline code by its hash, never with unsafe-inline (SEC-2)', () => {
    const directives = csp(build('run()', 'a{b:c}')).split('; ')
    expect(directives).toContain(`script-src ${hash('run()')}`)
    expect(directives).toContain(`style-src ${hash('a{b:c}')}`)
    expect(directives).toContain('worker-src blob:')
    expect(directives.join(';')).not.toMatch(/unsafe-inline|unsafe-eval/)
    // The rest is the policy of dist/.
    expect(directives.filter((d) => !/^(script|style|worker)-src /.test(d))).toEqual(
      CSP.filter((d) => !/^(script|style|worker)-src /.test(d)),
    )
  })

  it('escapes </script and hashes the code as written in the file', () => {
    const html = build('const s="</script>";const t=`</SCRIPT>`')
    expect(html).toContain('<script>const s="<\\/script>";const t=`<\\/SCRIPT>`</script>')
    expect(csp(html)).toContain(hash('const s="<\\/script>";const t=`<\\/SCRIPT>`'))
  })

  it('keeps replacement patterns of the bundle as they are', () => {
    const js = 'x.replace(/a/,"$&$1$$")'
    expect(build(js)).toContain(`<script>${js}</script>`)
    expect(build('1', 'a::after{content:"$\'$`"}')).toContain('<style>a::after{content:"$\'$`"}</style>')
  })

  it('places the code by the tags of the shell, not by tags inside the code', () => {
    const html = build('s="</body></head>"', 'a{content:"</head></body>"}')
    expect(html).toContain('<style>a{content:"</head></body>"}</style>\n  </head>')
    expect(html).toMatch(/<div id="root"><\/div>\n {4}<script>s="<\/body><\/head>"<\/script>\n {2}<\/body>\n<\/html>\n$/)
  })

  it('refuses code that the HTML parser would cut', () => {
    expect(() => build('s="<!--"')).toThrow(/<!--/)
    expect(() => build('1', 'a{content:"</style>"}')).toThrow(/<\/style/)
  })

  it('refuses an index.html that is not the expected one', () => {
    expect(() => singleFileHtml(INDEX, () => undefined)).toThrow(/missing/)
    expect(() => singleFileHtml(INDEX.replace(/<link[^>]*>/, ''), () => '')).toThrow(/one script and one stylesheet/)
    const twoScripts = INDEX.replace('</title>', '</title>\n    <script defer src="./assets/b.js"></script>')
    expect(() => singleFileHtml(twoScripts, () => '')).toThrow(/more than one/)
    expect(() => singleFileHtml(INDEX.replace(/<meta http-equiv[^>]*>/, ''), (p) => files('1')[p])).toThrow(/Content-Security-Policy/)
  })
})
