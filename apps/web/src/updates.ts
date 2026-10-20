import { APP_SLUG, IPFS_GATEWAYS, releaseD, type Filter, type NostrEvent } from '@smartcity/sdk'
import { KIND, RELEASE_CHANNELS, validateEvent, type ReleaseChannel, type ReleaseContent } from '@smartcity/schemas'

// APP-8: the app reads the `release` (kind 31486, docs/spec/06) signed by the developer keys embedded in the build
// (APP-5) and, when one announces a version newer than the one running, tells the user and offers its channels. It
// never applies the update by itself (APP-9): the user reloads the mirror, downloads `smartcity.html` or opens
// another copy, and compares the hash the release announces (DIST-2).

export interface Version {
  major: number
  minor: number
  patch: number
}

// `1.4.0`, `v1.4.0`, or a pre-release as `1.5.0-beta.1`; a date, a commit or anything else is not a version.
const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]*)?$/

/** The numbers of a semantic version, or null if the text is not one. */
export function parseVersion(version: string): Version | null {
  const match = VERSION.exec(version.trim())
  if (!match) return null
  const numbers = match.slice(1, 4).map(Number)
  if (!numbers.every((n) => Number.isSafeInteger(n))) return null
  return { major: numbers[0]!, minor: numbers[1]!, patch: numbers[2]! }
}

/**
 * Whether `candidate` comes after `current` (APP-8, "versión mayor"). A pre-release counts as its release: with
 * `1.0.0` running, `1.0.0-beta` is not news and `1.1.0-beta` is.
 */
export function isNewerVersion(current: string, candidate: string): boolean {
  const a = parseVersion(current)
  const b = parseVersion(candidate)
  if (!a || !b) return false
  if (a.major !== b.major) return b.major > a.major
  if (a.minor !== b.minor) return b.minor > a.minor
  return b.patch > a.patch
}

/** How the app names each release channel. */
export const CHANNEL_LABEL: Record<ReleaseChannel, string> = { stable: 'estable', beta: 'beta' }

/** A `release` the app believes and that is newer than the running build. */
export interface ReleaseOffer {
  channel: ReleaseChannel
  version: string
  content: ReleaseContent
  event: NostrEvent
}

export interface ReleaseCheck {
  /** APP-5, APP-8: developer keys of the build or chosen by the user. Only a `release` signed by one counts. */
  developers: readonly string[]
  /** Version of the running build (`__APP_VERSION__`, APP-10). */
  current: string
  /** App slug of the `d` tag. Default: `smartcity`. */
  slug?: string
}

type ReleaseQuery = (filters: Filter[]) => Promise<NostrEvent[]>

/**
 * APP-8: the newest `release` of each channel signed by a developer key that announces a newer version than
 * `current`, stable first. Events come from `Client.query`, which verifies their signature (SDK-5); here the author,
 * the address, the schema and the version are checked. Without developer keys or a version to compare, nothing.
 */
export function releaseOffers(events: readonly NostrEvent[], { developers, current, slug = APP_SLUG }: ReleaseCheck): ReleaseOffer[] {
  if (developers.length === 0 || !parseVersion(current)) return []
  const trusted = new Set(developers.map((pubkey) => pubkey.toLowerCase()))
  const newest = new Map<ReleaseChannel, ReleaseOffer>()
  for (const event of events) {
    const offer = offerOf(event, trusted, slug)
    if (!offer || !isNewerVersion(current, offer.version)) continue
    const seen = newest.get(offer.channel)
    // DATA-3: the winner of an address is the newest event, and the lowest id among equals.
    const wins =
      !seen || event.created_at > seen.event.created_at || (event.created_at === seen.event.created_at && event.id < seen.event.id)
    if (wins) newest.set(offer.channel, offer)
  }
  const offers: ReleaseOffer[] = []
  for (const channel of RELEASE_CHANNELS) {
    const offer = newest.get(channel)
    if (offer) offers.push(offer)
  }
  return offers
}

function offerOf(event: NostrEvent, trusted: ReadonlySet<string>, slug: string): ReleaseOffer | null {
  if (event.kind !== KIND.RELEASE || !trusted.has(event.pubkey.toLowerCase())) return null
  const d = event.tags.find((tag) => tag[0] === 'd')?.[1]
  const channel = RELEASE_CHANNELS.find((c) => d === releaseD(slug, c))
  if (!channel) return null
  const result = validateEvent(event)
  if (!result.ok) return null
  const content = result.content as ReleaseContent
  if (!parseVersion(content.version)) return null
  return { channel, version: content.version, content, event }
}

/**
 * APP-8: asks the relays (and the local store) for the `release` of each channel written by a developer key, in one
 * query. With no developer keys there is no key to believe and no query is made.
 */
export async function checkUpdates(query: ReleaseQuery, check: ReleaseCheck): Promise<ReleaseOffer[]> {
  if (check.developers.length === 0 || !parseVersion(check.current)) return []
  const slug = check.slug ?? APP_SLUG
  const events = await query(
    RELEASE_CHANNELS.map((channel) => ({ kinds: [KIND.RELEASE], authors: [...check.developers], '#d': [releaseD(slug, channel)] })),
  )
  return releaseOffers(events, check)
}

/** Where an announced version can be had (docs/spec/06, "Canales"). */
export interface ReleaseChannels {
  /** `smartcity.html` of that version (APP-4); download it and compare its sha256 with the one announced. */
  downloads: string[]
  /** Sites that serve the version (GOAL-3). */
  mirrors: string[]
  /** The multi-file build on IPFS gateways (DIST-1). */
  ipfs: string[]
  /** The torrent of `smartcity.html`, shown as text: SEC-1 only allows links with `https:` or `ipfs:`. */
  magnet: string | null
}

// SEC-1: an event only becomes a link if it is https; `javascript:`, `data:` or `http:` stay as they are.
const https = (url: string): string | null => (/^https:\/\//i.test(url) ? url : null)

/** APP-8: the channels of an announced version, as links the app may show (SEC-1). */
export function releaseChannels(content: ReleaseContent): ReleaseChannels {
  const cid = content.dist?.cid
  const magnet = content.dist?.magnet
  return {
    downloads: content.single.urls.flatMap((url) => https(url) ?? []),
    mirrors: (content.mirrors ?? []).flatMap((url) => https(url) ?? []),
    ipfs: cid ? IPFS_GATEWAYS.map((gateway) => `${gateway}/ipfs/${encodeURIComponent(cid)}/`) : [],
    magnet: magnet && /^magnet:\?/i.test(magnet) ? magnet : null,
  }
}
