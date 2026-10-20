import { useEffect } from 'react'
import { HashRouter, NavLink, Route, Routes } from 'react-router'
import { ClientProvider, useApp, useOutbox, useRelayStatus } from './client'
import { CityPicker } from './geo/CityPicker'
import { startAutoLocate, usePlace } from './geo/store'
import { AboutPage } from './pages/AboutPage'
import { HistoryPage } from './pages/HistoryPage'
import { IdentityPage } from './pages/IdentityPage'
import { MapPage } from './pages/MapPage'
import { RelaysPage } from './pages/RelaysPage'
import { ReportsPage } from './pages/ReportsPage'
import { TrustPage } from './pages/TrustPage'

function Header() {
  const { cityConfig, city, identity, anchors } = useApp()
  const relays = useRelayStatus()
  const outbox = useOutbox()
  const open = relays.filter((r) => r.state === 'open').length
  const place = usePlace()
  useEffect(startAutoLocate, [])
  return (
    <header className="bar">
      <strong className="brand">SmartCity</strong>
      <CityPicker name={place?.place.name ?? city?.content.name ?? cityConfig.name} />
      <nav>
        <NavLink to="/" end>
          Mapa
        </NavLink>
        <NavLink to="/historial">Historial</NavLink>
        <NavLink to="/reportes">Reportes</NavLink>
        <NavLink to="/relays">
          Relays <span className={`chip ${open === 0 ? 'bad' : 'ok'}`}>{`${open}/${relays.length}`}</span>
        </NavLink>
        <NavLink to="/confianza">
          Confianza {anchors.length === 0 && <span className="chip bad">sin anclas</span>}
        </NavLink>
        <NavLink to="/identidad">{identity ? 'Identidad' : 'Solo lectura'}</NavLink>
        <NavLink to="/acerca">Acerca de</NavLink>
      </nav>
      {outbox.length > 0 && (
        <span className="chip warn" title="Se enviarán cuando haya conexión con algún relay">
          {outbox.length} por enviar
        </span>
      )}
    </header>
  )
}

export function App() {
  return (
    <ClientProvider>
      <HashRouter>
        <div className="layout">
          <Header />
          <main>
            <Routes>
              <Route path="/" element={<MapPage />} />
              <Route path="/historial" element={<HistoryPage />} />
              <Route path="/reportes" element={<ReportsPage />} />
              <Route path="/relays" element={<RelaysPage />} />
              <Route path="/confianza" element={<TrustPage />} />
              <Route path="/identidad" element={<IdentityPage />} />
              <Route path="/acerca" element={<AboutPage />} />
            </Routes>
          </main>
        </div>
      </HashRouter>
    </ClientProvider>
  )
}
