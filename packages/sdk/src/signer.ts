import { decrypt, encrypt } from 'nostr-tools/nip49'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import type { EventTemplate, NostrEvent } from './event.js'

/**
 * Something that signs. The private key, if there is one, stays inside it (SEC-3): nothing in the SDK asks for it.
 */
export interface Signer {
  getPublicKey(): Promise<string>
  signEvent(template: EventTemplate): Promise<NostrEvent>
}

/** Signer over a key held in memory (ID-1). Generate one with `generateSecretKey`. */
export function localSigner(secretKey: Uint8Array): Signer {
  const key = secretKey.slice()
  const pubkey = getPublicKey(key)
  return {
    getPublicKey: async () => pubkey,
    signEvent: async (template) => finalizeEvent(template, key),
  }
}

export { generateSecretKey }

interface Nip07 {
  getPublicKey(): Promise<string>
  signEvent(template: EventTemplate): Promise<NostrEvent>
}

/** Browser extension signer, NIP-07 (ID-1). Looks up `window.nostr` when used, so extensions that load late work. */
export function nip07Signer(): Signer {
  const extension = (): Nip07 => {
    const nostr = (globalThis as { nostr?: Nip07 }).nostr
    if (!nostr) throw new Error('no NIP-07 extension found (window.nostr)')
    return nostr
  }
  let pubkey: Promise<string> | undefined
  return {
    getPublicKey: () => (pubkey ??= extension().getPublicKey()),
    signEvent: (template) => extension().signEvent(template),
  }
}

export function hasNip07(): boolean {
  return typeof (globalThis as { nostr?: unknown }).nostr === 'object'
}

/** ID-2: a local key at rest is encrypted with the user's passphrase (NIP-49, `ncryptsec1…`). */
export function encryptSecretKey(secretKey: Uint8Array, passphrase: string): string {
  return encrypt(secretKey, passphrase)
}

/** Opens an `ncryptsec1…`. Throws when the passphrase is wrong. */
export function decryptSecretKey(ncryptsec: string, passphrase: string): Uint8Array {
  return decrypt(ncryptsec, passphrase)
}
