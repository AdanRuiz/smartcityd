import { HashRouter, NavLink, Route, Routes } from 'react-router'
import { ClientProvider, useApp, useRelayStatus } from './client'
import { IdentityPage } from './pages/IdentityPage'
import { MapPage } from './pages/MapPage'
import { RelaysPage } from './pages/RelaysPage'

function Header() {
  const { cityConfig, city, identity } = useApp()
  const relays = useRelayStatus()
  const open = relays.filter((r) => r.state === 'open').length
  return (
    <header className="bar">
      <strong className="brand">SmartCity</strong>
      <span className="city">{city?.content.name ?? cityConfig.name}</span>
      <nav>
        <NavLink to="/" end>
          Mapa
        </NavLink>
        <NavLink to="/relays">
          Relays <span className={`chip ${open === 0 ? 'bad' : 'ok'}`}>{`${open}/${relays.length}`}</span>
        </NavLink>
        <NavLink to="/identidad">{identity ? 'Identidad' : 'Solo lectura'}</NavLink>
      </nav>
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
              <Route path="/relays" element={<RelaysPage />} />
              <Route path="/identidad" element={<IdentityPage />} />
            </Routes>
          </main>
        </div>
      </HashRouter>
    </ClientProvider>
  )
}
