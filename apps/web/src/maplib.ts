import { layers, namedFlavor } from '@protomaps/basemaps'
import { addProtocol, setWorkerUrl, type StyleSpecification } from 'maplibre-gl'
import workerModule from 'maplibre-gl/dist/maplibre-gl-worker.mjs?raw'
import 'maplibre-gl/dist/maplibre-gl.css'
import { FileSource, PMTiles, Protocol } from 'pmtiles'

// The map worker starts from in-memory code: a worker loaded from a file next to the page is refused under
// file:// (APP-2). Its only module syntax is the final `export`; without it the same code runs as a classic script.
const workerCode = workerModule.replace(/\/\/# sourceMappingURL=.*\s*$/, '').replace(/export\s*\{[^}]*\};?\s*$/, '')
const workerUrl = URL.createObjectURL(new Blob([workerCode], { type: 'text/javascript' }))
setWorkerUrl(workerUrl)

// Under file:// Chrome refuses module workers from blob: URLs and MapLibre always asks for one (wrapping the URL
// in another blob, because a blob of an opaque origin looks cross-origin to it). There, start the classic worker.
if (location.protocol === 'file:') {
  const NativeWorker = window.Worker
  window.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      if (options?.type === 'module' && String(url).startsWith('blob:')) super(workerUrl)
      else super(url, options)
    }
  }
}

const protocol = new Protocol()
addProtocol('pmtiles', protocol.tile)

export const BASEMAP_SOURCE = 'basemap'

/** A PMTiles file picked from disk: the map works with no network for the tiles (copy distributed by torrent). */
export function registerLocalTiles(file: File): string {
  const tiles = new PMTiles(new FileSource(file))
  protocol.add(tiles)
  return `pmtiles://${tiles.source.getKey()}`
}

/**
 * Map style. With a PMTiles URL, the Protomaps basemap without label layers: labels need glyph files from a
 * server, and APP-3 forbids third-party resources at runtime. Without tiles, a plain background.
 */
export function mapStyle(tilesUrl: string | null, dark: boolean): StyleSpecification {
  const background = dark ? '#1b1f24' : '#eef0f2'
  if (!tilesUrl) {
    return { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': background } }] }
  }
  const flavor = namedFlavor(dark ? 'dark' : 'light')
  return {
    version: 8,
    sources: {
      [BASEMAP_SOURCE]: {
        type: 'vector',
        url: tilesUrl.startsWith('pmtiles://') ? tilesUrl : `pmtiles://${tilesUrl}`,
        attribution: '© OpenStreetMap',
      },
    },
    layers: layers(BASEMAP_SOURCE, flavor).filter((l) => l.type !== 'symbol'),
  }
}
