import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { buildInfo } from './build/build-info'
import { CSP, SINGLE_FILE, singleFileHtml } from './build/single-file'
import { BUILD_META } from './src/variant'

/**
 * APP-2: browsers refuse module scripts from file://, so the build emits one classic script, loaded with `defer`
 * from a relative path, and adds the CSP. Only for the build: the dev server needs its inline module preamble.
 * APP-10: also writes the build id (`BUILD_META`), which `smartcity.html` keeps, from the names of the assets: they
 * carry the hash of their content, so the id changes with the code and stays the same for the same sources (APP-6).
 */
function staticApp(): Plugin {
  return {
    name: 'smartcity-static-app',
    apply: 'build',
    enforce: 'post',
    transformIndexHtml(html, ctx) {
      if (!ctx.bundle) throw new Error('static app: no bundle to take the build id from')
      const assets = Object.keys(ctx.bundle).filter((f) => f.startsWith('assets/')).sort().join('|')
      const id = createHash('sha256').update(assets).digest('hex').slice(0, 16)
      return html
        .replace(/<script type="module" crossorigin src="([^"]+)"><\/script>/g, '<script defer src="$1"></script>')
        .replace(/<link rel="stylesheet" crossorigin href=/g, '<link rel="stylesheet" href=')
        .replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP.join('; ')}" />\n    <meta name="${BUILD_META}" content="${id}" />`)
    },
  }
}

/**
 * Service Worker (`06`, APP-4, APP-7): keeps the shell (index.html, script, styles) so the app opens with no network
 * when served over HTTP(S). The list of files and the cache name come from this build, so a new deployment replaces
 * the old cache. Never used under file://, where the app works the same without it.
 */
function serviceWorker(): Plugin {
  return {
    name: 'smartcity-service-worker',
    apply: 'build',
    // After Vite emits the stylesheet, so it is in the list.
    enforce: 'post',
    generateBundle(_, bundle) {
      const files = ['./', './index.html', ...Object.keys(bundle).filter((f) => !f.endsWith('.html')).map((f) => `./${f}`)]
      const version = Object.keys(bundle).filter((f) => f.startsWith('assets/')).sort().join('|')
      const source = readFileSync(new URL('./src/sw.js', import.meta.url), 'utf8')
        .replace('self.__SHELL__', JSON.stringify(files))
        .replace('self.__VERSION__', JSON.stringify(createHash('sha256').update(version).digest('hex').slice(0, 12)))
      this.emitFile({ type: 'asset', fileName: 'sw.js', source })
    },
  }
}

/**
 * APP-4: besides dist/ (several files, with Service Worker), the build emits `smartcity.html`, the same app in one
 * self-contained file, without Service Worker.
 */
function singleFile(): Plugin {
  return {
    name: 'smartcity-single-file',
    apply: 'build',
    // After Vite emits index.html and the stylesheet.
    enforce: 'post',
    generateBundle(_, bundle) {
      const text = (fileName: string) => {
        const output = bundle[fileName]
        if (!output) return undefined
        if (output.type === 'chunk') return output.code
        return typeof output.source === 'string' ? output.source : new TextDecoder().decode(output.source)
      }
      const html = text('index.html')
      if (html === undefined) throw new Error('single file: index.html not in the bundle')
      this.emitFile({ type: 'asset', fileName: SINGLE_FILE, source: singleFileHtml(html, text) })
    },
  }
}

// APP-10: version and commit shown in "Acerca de".
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }
const info = buildInfo(pkg.version)

export default defineConfig({
  base: './',
  plugins: [react(), staticApp(), serviceWorker(), singleFile()],
  define: {
    __APP_VERSION__: JSON.stringify(info.version),
    __APP_COMMIT__: JSON.stringify(info.commit),
    __APP_DIRTY__: JSON.stringify(info.dirty),
  },
  worker: { format: 'iife' },
  build: {
    target: 'es2022',
    modulePreload: false,
    cssCodeSplit: false,
    assetsInlineLimit: 0,
    sourcemap: false,
    rolldownOptions: {
      output: { format: 'iife', codeSplitting: false, entryFileNames: 'assets/app-[hash].js' },
    },
  },
})
