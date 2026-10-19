// Shared by the build (build/) and the app: no Node or DOM imports at module level.

/** File name of the single-file variant (APP-4). */
export const SINGLE_FILE = 'smartcity.html'

/** `<meta name>` that marks the single-file variant, so the app does not register the Service Worker (APP-4). */
export const VARIANT_META = 'smartcity-variant'

/**
 * `<meta name>` with the id of this build (APP-10): a hash of the names of its assets, which carry the hash of their
 * content. `index.html` and `smartcity.html` of one build share it, so the app can tell whether a file it downloads
 * belongs to the build that is running. Deterministic: same sources, same id (APP-6).
 */
export const BUILD_META = 'smartcity-build'

const metaContent = (name: string) => new RegExp(`<meta name="${name}" content="([^"]*)"`)

/** True in `smartcity.html`. */
export function isSingleFile(doc: Pick<Document, 'querySelector'> = document): boolean {
  return doc.querySelector(`meta[name="${VARIANT_META}"]`)?.getAttribute('content') === 'single-file'
}

/** Build id of the running page, or null in development, where the build does not add it. */
export function runningBuildId(doc: Pick<Document, 'querySelector'> = document): string | null {
  return doc.querySelector(`meta[name="${BUILD_META}"]`)?.getAttribute('content') ?? null
}

/** Build id written in an HTML file of the build, or null if it has none. */
export function buildIdOf(html: string): string | null {
  return metaContent(BUILD_META).exec(html)?.[1] ?? null
}
