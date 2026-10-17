import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { GEO } from '../config'
import { searchCities, type Place } from './places'
import { setPlace } from './store'

const where = (p: Place) => [p.region, p.country].filter(Boolean).join(', ')

/**
 * APP-14: the city name in the header with an edit button. Editing turns the name into a text field with the
 * current name selected; typing suggests cities (name, and below in smaller type state/region and country), and
 * choosing one moves the map there (APP-15). Escape or leaving the field cancels.
 */
export function CityPicker({ name }: { name: string }) {
  const [editing, setEditing] = useState(false)
  const [query, setQuery] = useState(name)
  const [results, setResults] = useState<Place[]>([])
  const [active, setActive] = useState(0)
  const [status, setStatus] = useState<'idle' | 'searching' | 'error'>('idle')
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) input.current?.select()
  }, [editing])

  // Debounced search; a new keystroke cancels the request in flight.
  useEffect(() => {
    if (!editing || query.trim() === name || query.trim().length < 2) {
      setResults([])
      setStatus('idle')
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      setStatus('searching')
      searchCities(query, controller.signal).then(
        (found) => {
          setResults(found)
          setActive(0)
          setStatus('idle')
        },
        () => !controller.signal.aborted && setStatus('error'),
      )
    }, GEO.debounceMs)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [query, editing, name])

  const open = () => {
    setQuery(name)
    setResults([])
    setEditing(true)
  }
  const close = () => {
    setEditing(false)
    setResults([])
  }
  const choose = (place: Place) => {
    setPlace(place, 'manual')
    close()
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') close()
    else if (e.key === 'ArrowDown') setActive((i) => Math.min(i + 1, results.length - 1))
    else if (e.key === 'ArrowUp') setActive((i) => Math.max(i - 1, 0))
    else if (e.key === 'Enter' && results[active]) choose(results[active])
    else return
    e.preventDefault()
  }

  if (!editing) {
    return (
      <span className="city">
        <span>{name}</span>
        <button type="button" className="icon-button" onClick={open} title="Cambiar de ciudad" aria-label="Cambiar de ciudad">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <path
              fill="currentColor"
              d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zm17.71-10.21a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"
            />
          </svg>
        </button>
      </span>
    )
  }

  return (
    <span className="city city-edit">
      <input
        ref={input}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKey}
        onBlur={close}
        aria-label="Buscar ciudad"
        aria-autocomplete="list"
        autoComplete="off"
        spellCheck={false}
      />
      {(results.length > 0 || status !== 'idle') && (
        <ul className="suggestions" role="listbox">
          {status === 'searching' && results.length === 0 && <li className="muted">Buscando…</li>}
          {status === 'error' && <li className="muted">Sin conexión con el buscador de ciudades</li>}
          {results.map((p, i) => (
            <li
              key={`${p.name}|${p.region}|${p.country}|${p.lat}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : undefined}
              // mousedown, not click: it runs before the field's blur closes the list.
              onMouseDown={(e) => {
                e.preventDefault()
                choose(p)
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span>{p.name}</span>
              {where(p) && <small>{where(p)}</small>}
            </li>
          ))}
        </ul>
      )}
    </span>
  )
}
