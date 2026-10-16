import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// SEC-2. `worker-src blob:` because the map, signature and proof-of-work workers start from in-memory code (works from
// file://); 'self' for the Service Worker.
// `ws:` only for a relay on this machine during development.
const CSP = [
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
].join('; ')

/**
 * APP-2: browsers refuse module scripts from file://, so the build emits one classic script, loaded with `defer`
 * from a relative path, and adds the CSP. Only for the build: the dev server needs its inline module preamble.
 */
function staticApp(): Plugin {
  return {
    name: 'smartcity-static-app',
    apply: 'build',
    enforce: 'post',
    transformIndexHtml(html) {
      return html
        .replace(/<script type="module" crossorigin src="([^"]+)"><\/script>/g, '<script defer src="$1"></script>')
        .replace(/<link rel="stylesheet" crossorigin href=/g, '<link rel="stylesheet" href=')
        .replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`)
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

export default defineConfig({
  base: './',
  plugins: [react(), staticApp(), serviceWorker()],
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
