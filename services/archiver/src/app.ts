import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { directoryCid } from './ipfs.js'
import { createTorrent, seedUrl } from './torrent.js'

// `archiver app`: the `dist` of a `release` event (docs/spec/06, kind 31486) for a build of the app, so the
// developer can put it in the draft before signing (`city.mjs draft-release --dist-cid --dist-magnet`). It
// publishes the build on the two networks of DIST-1:
// - IPFS: the CID of the whole `dist/` directory, which serves the app at `https://<gateway>/ipfs/<cid>/` (APP-2).
// - BitTorrent: a torrent of `smartcity.html` alone (APP-4), the file a torrent user opens with a double click
//   ("Canales"). Its web seeds are the mirrors themselves, which serve it at `<mirror>/smartcity.html` (DIST-3); a
//   torrent of the whole directory could not use them, since BEP-19 looks for its files under `<mirror>/<name>/`.

/** The single-file variant inside the build (APP-4). */
export const SINGLE_FILE = 'smartcity.html'

export interface AppOptions {
  /** The multi-file build, `apps/web/dist`. */
  dir: string
  /** Where to write `smartcity.html.torrent`. */
  out: string
  /** Bases where `smartcity.html` is served: the mirrors (GOAL-3). */
  webSeeds: readonly string[]
  trackers?: readonly string[]
}

export interface AppResult {
  /** `dist.cid`. */
  cid: string
  /** `dist.magnet`. */
  magnet: string
  /** sha256 of `smartcity.html`, the `x` of the `release` (DIST-2). */
  x: string
  torrent: string
}

/**
 * Every file under `dir` by its path relative to it with `/`, skipping hidden entries (`.name`) as `ipfs add -r`
 * does by default.
 */
export async function readTree(dir: string): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>()
  const walk = async (at: string): Promise<void> => {
    const entries = await readdir(at, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const path = join(at, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) files.set(relative(dir, path).split(sep).join('/'), await readFile(path))
    }
  }
  await walk(dir)
  return files
}

export async function runApp(options: AppOptions, log: (line: string) => void): Promise<AppResult> {
  const files = await readTree(options.dir)
  const single = files.get(SINGLE_FILE)
  if (!single) throw new Error(`${options.dir}: no ${SINGLE_FILE}; build the app first (pnpm build)`)

  const cid = directoryCid(files)
  const torrent = createTorrent(single, {
    name: SINGLE_FILE,
    trackers: options.trackers,
    webSeeds: options.webSeeds.map((base) => seedUrl(base, SINGLE_FILE)),
  })
  const path = join(options.out, `${SINGLE_FILE}.torrent`)
  await writeFile(path, torrent.bytes)
  const x = createHash('sha256').update(single).digest('hex')
  log(`${options.dir}: ${files.size} files, cid ${cid}`)
  log(`${path}: ${SINGLE_FILE} ${single.length} bytes, sha256 ${x}, info hash ${torrent.infoHash}`)
  if (options.webSeeds.length === 0) log('warning: no --web-seed; the torrent only has peers found by trackers and DHT')
  return { cid, magnet: torrent.magnet, x, torrent: path }
}
