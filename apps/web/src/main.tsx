import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// APP-7: the Service Worker only over HTTP(S) and in the build; from file:// or an IPFS subpath without it, the app
// works the same, without opening offline.
if (import.meta.env.PROD && location.protocol.startsWith('http') && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {})
}
