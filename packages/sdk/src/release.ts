import { KIND, RELEASE_CHANNELS, validateEvent, type ReleaseChannel, type ReleaseContent } from '@smartcity/schemas'
import { ValidationError } from './client.js'

/** Slug of this repository's app in the `d` tag of its `release` (`smartcity:stable`). */
export const APP_SLUG = 'smartcity'

export interface ReleaseInput {
  /** `d` = `<slug>:<channel>`; the slug may not contain `:`. Defaults: `smartcity`, `stable`. */
  slug?: string
  channel?: ReleaseChannel
  version: string
  /** Git commit the build was made from (APP-6, APP-10). */
  commit: string
  /** `smartcity.html` (APP-4): sha256 hex, size in bytes and HTTP(S) URLs where it can be downloaded. */
  single: ReleaseContent['single']
  /**
   * The build on IPFS and BitTorrent (DIST-1, DIST-3): CID of the multi-file `dist/` and magnet of `smartcity.html`
   * with the mirrors as web seeds, as `archiver app` computes them.
   */
  dist?: ReleaseContent['dist']
  /** Mirrors that serve this version (GOAL-3). */
  mirrors?: string[]
  notes?: string
}

/** The `d` tag of a release: one current version per app and channel (docs/spec/06). */
export function releaseD(slug: string, channel: ReleaseChannel): string {
  return `${slug}:${channel}`
}

/**
 * Unsigned `release` event (kind 31486, docs/spec/06) announcing a build of the app by the sha256 of
 * `smartcity.html` (DIST-2): that hash, not a URL, is the reference, so it goes both in the `x` tag and in
 * `single.x`. Throws `ValidationError` if the result does not match the schema (EVT-7).
 */
export function releaseTemplate(input: ReleaseInput): { kind: number; tags: string[][]; content: string } {
  const slug = input.slug ?? APP_SLUG
  const channel = input.channel ?? 'stable'
  const errors: string[] = []
  if (slug.length === 0 || slug.includes(':')) errors.push(`slug must be non-empty and without ':': ${JSON.stringify(slug)}`)
  if (!RELEASE_CHANNELS.includes(channel)) errors.push(`channel must be one of ${RELEASE_CHANNELS.join(', ')}`)
  if (errors.length > 0) throw new ValidationError(errors)

  const content: ReleaseContent = {
    v: 1,
    version: input.version,
    commit: input.commit,
    single: { x: input.single.x, size: input.single.size, urls: [...input.single.urls] },
    ...(input.dist && Object.keys(input.dist).length > 0 ? { dist: { ...input.dist } } : {}),
    ...(input.mirrors && input.mirrors.length > 0 ? { mirrors: [...input.mirrors] } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
  }
  const template = {
    kind: KIND.RELEASE,
    tags: [
      ['d', releaseD(slug, channel)],
      ['x', input.single.x],
    ],
    content: JSON.stringify(content),
  }
  const result = validateEvent(template)
  if (!result.ok) throw new ValidationError(result.errors)
  return template
}
