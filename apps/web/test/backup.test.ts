import { encryptSecretKey, generateSecretKey } from '@smartcity/sdk'
import { describe, expect, it } from 'vitest'
import { applyBackup, backupText, parseBackup, type Backup, type Storage } from '../src/backup'
import { PLACE_KEY, type CurrentPlace } from '../src/geo/store'
import { KEY_ITEM } from '../src/identity'
import { SETTINGS_KEY, type Settings } from '../src/settings'

const settings: Settings = { city: 'mx-monterrey', relays: ['wss://relay.example'], anchors: { 'mx-gdl': ['a'.repeat(64)] } }
const chosen: CurrentPlace = { place: { name: 'Monterrey', countryCode: 'MX', lat: 25.67, lon: -100.31, bbox: [25.5, -100.5, 25.8, -100.1] }, source: 'manual' }
const key = () => encryptSecretKey(generateSecretKey(), 'una frase larga')

/** localStorage stand-in; `full` makes every write fail, as in a private window. */
function memory(initial: Record<string, string> = {}, full = false): Storage & { items: Record<string, string> } {
  const items = { ...initial }
  return {
    items,
    read: (k) => items[k] ?? null,
    write: (k, v) => {
      if (full) return false
      items[k] = v
      return true
    },
  }
}

describe('backup of settings and key between origins (APP-11)', () => {
  it('carries settings, the chosen city and the encrypted key, and reads them back', () => {
    const backup: Backup = { settings, place: chosen, ncryptsec: key() }
    expect(parseBackup(backupText(backup))).toEqual(backup)
  })

  it('leaves out a detected place and a missing key', () => {
    const text = backupText({ settings, place: { ...chosen, source: 'ip' }, ncryptsec: null })
    expect(JSON.parse(text)).toEqual({ format: 'smartcity-backup', v: 1, settings })
    expect(parseBackup(text)).toEqual({ settings, place: null, ncryptsec: null })
  })

  it('never takes a key in clear (ID-2)', () => {
    const file = (ncryptsec: unknown) => JSON.stringify({ format: 'smartcity-backup', v: 1, settings, ncryptsec })
    expect(() => parseBackup(file('nsec1' + 'q'.repeat(58)))).toThrow(/cifrada/)
    expect(() => parseBackup(file('b'.repeat(64)))).toThrow(/cifrada/)
    expect(() => parseBackup(file(42))).toThrow(/cifrada/)
  })

  it('refuses what is not a backup of this version', () => {
    expect(() => parseBackup('ncryptsec1…')).toThrow(/JSON/)
    expect(() => parseBackup(JSON.stringify({ settings }))).toThrow(/SmartCity/)
    expect(() => parseBackup(JSON.stringify({ format: 'smartcity-backup', settings }))).toThrow(/versión/)
    expect(() => parseBackup(JSON.stringify({ format: 'smartcity-backup', v: 2, settings }))).toThrow(/más nueva/)
    expect(() => parseBackup(JSON.stringify({ format: 'smartcity-backup', v: 1 }))).toThrow(/ajustes/)
  })

  it('reads settings and place as the app reads its own: what is not valid falls back', () => {
    const text = JSON.stringify({ format: 'smartcity-backup', v: 1, settings: { relays: 'x' }, place: { place: { name: 'X' }, source: 'manual' } })
    const backup = parseBackup(text)
    expect(backup.settings.relays.length).toBeGreaterThan(0)
    expect(backup.place).toBeNull()
  })

  it('stores everything where the app reads it on reload', () => {
    const ncryptsec = key()
    const storage = memory()
    expect(applyBackup({ settings, place: chosen, ncryptsec }, storage)).toEqual({ saved: true, key: 'imported' })
    expect(JSON.parse(storage.items[SETTINGS_KEY]!)).toEqual(settings)
    expect(JSON.parse(storage.items[PLACE_KEY]!)).toEqual(chosen)
    expect(storage.items[KEY_ITEM]).toBe(ncryptsec)
  })

  it('never overwrites another key already stored, and keeps the place when the backup has none', () => {
    const mine = key()
    const storage = memory({ [KEY_ITEM]: mine, [PLACE_KEY]: 'saved' })
    expect(applyBackup({ settings, place: null, ncryptsec: key() }, storage)).toEqual({ saved: true, key: 'kept' })
    expect(storage.items[KEY_ITEM]).toBe(mine)
    expect(storage.items[PLACE_KEY]).toBe('saved')
    expect(applyBackup({ settings, place: null, ncryptsec: mine }, storage).key).toBe('same')
  })

  it('says so when the browser stores nothing', () => {
    expect(applyBackup({ settings, place: chosen, ncryptsec: key() }, memory({}, true))).toEqual({ saved: false, key: 'none' })
  })
})
