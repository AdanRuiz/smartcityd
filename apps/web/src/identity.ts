import { decryptSecretKey, encryptSecretKey, generateSecretKey, localSigner, nip07Signer, type Signer } from '@smartcity/sdk'
import { decode } from 'nostr-tools/nip19'
import { readItem, writeItem } from './settings'

// ID-2: the local key is kept only as NIP-49 `ncryptsec` (encrypted with the user's passphrase), never in clear.
export const KEY_ITEM = 'sc.ncryptsec'

export type IdentityKind = 'nip07' | 'local'

export const storedKey = (): string | null => readItem(KEY_ITEM)

/** A pubkey as 64 hex characters, from `npub1…` or hex; null if it is neither (TRUST-2, APP-8). */
export function parsePubkey(text: string): string | null {
  const t = text.trim()
  if (/^[0-9a-f]{64}$/.test(t)) return t
  try {
    if (!t.startsWith('npub1')) return null
    return decode(t as `npub1${string}`).data
  } catch {
    return null
  }
}

export function createLocalKey(passphrase: string): { signer: Signer; ncryptsec: string; persisted: boolean } {
  const sk = generateSecretKey()
  const ncryptsec = encryptSecretKey(sk, passphrase)
  const signer = localSigner(sk)
  sk.fill(0)
  return { signer, ncryptsec, persisted: writeItem(KEY_ITEM,ncryptsec) }
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
  writeItem(KEY_ITEM,ncryptsec.trim())
  return signer
}

export const forgetLocalKey = (): boolean => writeItem(KEY_ITEM,null)

export const extensionSigner = nip07Signer
