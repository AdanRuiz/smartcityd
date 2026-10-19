import { parseSavedPlace, PLACE_KEY, type CurrentPlace } from './geo/store'
import { KEY_ITEM } from './identity'
import { parseSettings, readItem, SETTINGS_KEY, writeItem, type Settings } from './settings'

// APP-11: what the app keeps belongs to the origin, so another mirror, an IPFS gateway or `smartcity.html` opened
// from file:// starts empty. A backup file carries the settings, the city chosen by the user (APP-15) and the
// local key, only as NIP-49 `ncryptsec` (ID-2), from one origin to another. It never leaves the device by itself.

export const BACKUP_FORMAT = 'smartcity-backup'
export const BACKUP_VERSION = 1
export const BACKUP_FILE = 'smartcity-ajustes.json'

export interface Backup {
  settings: Settings
  place: CurrentPlace | null
  ncryptsec: string | null
}

const NCRYPTSEC = /^ncryptsec1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+$/

/** The file's text. Only a choice of the user is a place worth carrying: detection runs again on the other origin. */
export function backupText(backup: Backup): string {
  const place = backup.place?.source === 'manual' ? backup.place : null
  return `${JSON.stringify(
    {
      format: BACKUP_FORMAT,
      v: BACKUP_VERSION,
      settings: backup.settings,
      ...(place ? { place } : {}),
      ...(backup.ncryptsec ? { ncryptsec: backup.ncryptsec } : {}),
    },
    null,
    2,
  )}\n`
}

/** Reads a backup file. Throws with a message for the user when it is not one this version understands. */
export function parseBackup(text: string): Backup {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('el archivo no es JSON')
  }
  if (!data || typeof data !== 'object' || (data as Record<string, unknown>).format !== BACKUP_FORMAT)
    throw new Error('no es una copia de ajustes de SmartCity')
  const d = data as Record<string, unknown>
  if (typeof d.v !== 'number' || !Number.isInteger(d.v) || d.v < 1) throw new Error('la copia no tiene versión válida')
  if (d.v > BACKUP_VERSION) throw new Error('la copia es de una versión más nueva de la app: ábrela con esa versión')
  if (!d.settings || typeof d.settings !== 'object') throw new Error('la copia no trae ajustes')
  let ncryptsec: string | null = null
  if (d.ncryptsec !== undefined) {
    // ID-2: a key only enters encrypted; anything else (an nsec, a hex key) is refused rather than stored.
    if (typeof d.ncryptsec !== 'string' || !NCRYPTSEC.test(d.ncryptsec.trim())) throw new Error('la llave de la copia no está cifrada (ncryptsec1…)')
    ncryptsec = d.ncryptsec.trim()
  }
  return { settings: parseSettings(d.settings), place: parseSavedPlace(d.place), ncryptsec }
}

/**
 * What happened to the key of the backup: stored, the same one was already stored, or this origin already has another
 * one, which is never overwritten (losing it would be for good).
 */
export type KeyOutcome = 'none' | 'imported' | 'same' | 'kept'

export interface Storage {
  read(key: string): string | null
  write(key: string, value: string): boolean
}

const localStorageItems: Storage = { read: readItem, write: writeItem }

/**
 * Stores the backup in this origin, to take effect on reload. `saved` is false when the browser does not let the app
 * store anything (then nothing was changed). A backup without a place leaves the current choice.
 */
export function applyBackup(backup: Backup, storage: Storage = localStorageItems): { saved: boolean; key: KeyOutcome } {
  if (!storage.write(SETTINGS_KEY, JSON.stringify(backup.settings))) return { saved: false, key: 'none' }
  if (backup.place) storage.write(PLACE_KEY, JSON.stringify(backup.place))
  if (!backup.ncryptsec) return { saved: true, key: 'none' }
  const stored = storage.read(KEY_ITEM)
  if (stored === backup.ncryptsec) return { saved: true, key: 'same' }
  if (stored) return { saved: true, key: 'kept' }
  return { saved: true, key: storage.write(KEY_ITEM, backup.ncryptsec) ? 'imported' : 'none' }
}
