import { decryptSecretKey, encryptSecretKey, generateSecretKey, localSigner, nip07Signer, type Signer } from '@smartcity/sdk'
import { readItem, writeItem } from './settings'

// ID-2: the local key is kept only as NIP-49 `ncryptsec` (encrypted with the user's passphrase), never in clear.
const KEY = 'sc.ncryptsec'

export type IdentityKind = 'nip07' | 'local'

export const storedKey = (): string | null => readItem(KEY)

export function createLocalKey(passphrase: string): { signer: Signer; ncryptsec: string; persisted: boolean } {
  const sk = generateSecretKey()
  const ncryptsec = encryptSecretKey(sk, passphrase)
  const signer = localSigner(sk)
  sk.fill(0)
  return { signer, ncryptsec, persisted: writeItem(KEY, ncryptsec) }
}

/** Throws when the passphrase is wrong. */
export function unlockLocalKey(passphrase: string, ncryptsec = storedKey()): Signer {
  if (!ncryptsec) throw new Error('no hay llave guardada')
  const sk = decryptSecretKey(ncryptsec.trim(), passphrase)
  const signer = localSigner(sk)
  sk.fill(0)
  return signer
}

export function importLocalKey(ncryptsec: string, passphrase: string): Signer {
  const signer = unlockLocalKey(passphrase, ncryptsec)
  writeItem(KEY, ncryptsec.trim())
  return signer
}

export const forgetLocalKey = (): boolean => writeItem(KEY, null)

export const extensionSigner = nip07Signer
