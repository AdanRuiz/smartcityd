/* global self, caches, fetch, URL */
// Service Worker of the app shell (docs/spec/06, APP-7). Template: the build fills the list of files and the version.
// Data never goes through here: it comes from relays over WebSocket and lives in IndexedDB (SDK-4).
const SHELL = self.__SHELL__
const CACHE = `smartcity-shell-${self.__VERSION__}`

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('smartcity-shell-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return
  // Pages: network first, so a new deployment shows at once; the cached shell when offline.
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('./index.html', { ignoreSearch: true })))
    return
  }
  // Files of the build carry a hash in their name: the cached copy is always right.
  event.respondWith(caches.match(request).then((cached) => cached ?? fetch(request)))
})
