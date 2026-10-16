import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// SEC-2. `worker-src blob:` because the map and signature workers start from in-memory code (works from file://).
// `ws:` only for a relay on this machine during development.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "worker-src blob:",
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

export default defineConfig({
  base: './',
  plugins: [react(), staticApp()],
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
