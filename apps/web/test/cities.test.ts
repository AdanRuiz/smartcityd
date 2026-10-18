import { describe, expect, it } from 'vitest'
import { cityForPlace, cityIdFor } from '../src/cities'
import type { CityConfig } from '../src/config'
import type { Place } from '../src/geo/places'
import { parseSettings } from '../src/settings'

const GDL: CityConfig = { id: 'mx-gdl', name: 'Guadalajara', roots: ['a'.repeat(64)], bbox: [20.55, -103.47, 20.78, -103.24] }
const place = (name: string, lat: number, lon: number, countryCode?: string): Place => ({
  name,
  countryCode,
  lat,
  lon,
  bbox: [lat - 0.1, lon - 0.1, lat + 0.1, lon + 0.1],
})

describe('city of the data (APP-17, EVT-1)', () => {
  it('builds an id from the country and the name', () => {
    expect(cityIdFor('MX', 'Monterrey')).toBe('mx-monterrey')
    expect(cityIdFor('mx', 'San Pedro Garza García')).toBe('mx-san-pedro-garza-garcia')
    expect(cityIdFor('es', 'A Coruña')).toBe('es-a-coruna')
  })

  it('keeps ids within 32 characters and refuses what cannot be one', () => {
    const id = cityIdFor('de', 'Frankfurt am Main Rhein-Main-Gebiet Hessen')!
    expect(id.length).toBeLessThanOrEqual(32)
    expect(id).not.toMatch(/-$/)
    expect(cityIdFor('mx', '東京')).toBeNull()
    expect(cityIdFor('mex', 'Monterrey')).toBeNull()
  })

  it('uses the city of the build when the place falls in its area, with its roots (TRUST-1)', () => {
    expect(cityForPlace(place('Zapopan', 20.72, -103.39, 'mx'), [GDL])).toBe(GDL)
  })

  it('gives any other city its own id and no roots (TRUST-3)', () => {
    const mty = cityForPlace(place('Monterrey', 25.67, -100.31, 'mx'), [GDL])
    expect(mty).toMatchObject({ id: 'mx-monterrey', name: 'Monterrey', roots: [] })
  })

  it('has no city for a place without country code', () => {
    expect(cityForPlace(place('Mi ubicación', 25.67, -100.31), [GDL])).toBeNull()
  })
})

describe('anchors by city (APP-18, TRUST-2)', () => {
  it('moves the single list saved before to the city it was saved with', () => {
    const s = parseSettings({ city: 'mx-gdl', relays: ['wss://r'], anchors: ['b'.repeat(64)] })
    expect(s.anchors).toEqual({ 'mx-gdl': ['b'.repeat(64)] })
    expect(s.relays).toEqual(['wss://r'])
  })

  it('reads anchors by city and drops what is not a list of keys', () => {
    const s = parseSettings({ anchors: { 'mx-gdl': ['c'.repeat(64)], 'mx-monterrey': 'x' } })
    expect(s.anchors).toEqual({ 'mx-gdl': ['c'.repeat(64)] })
  })

  it('starts with no anchors chosen when nothing was saved', () => {
    expect(parseSettings(null).anchors).toEqual({})
    expect(parseSettings({ anchors: null }).anchors).toEqual({})
  })
})
