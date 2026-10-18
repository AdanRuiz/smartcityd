import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SINGLE_FILE, readTree, runApp } from '../src/app.js'
import { directoryCid } from '../src/ipfs.js'
import { createTorrent } from '../src/torrent.js'

const single = Buffer.from('<!doctype html><title>SmartCity</title>')

async function build(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'archiver-app-'))
  await mkdir(join(dir, 'assets'))
  await writeFile(join(dir, 'index.html'), '<!doctype html>')
  await writeFile(join(dir, 'assets', 'index.js'), 'console.log(1)')
  await writeFile(join(dir, SINGLE_FILE), single)
  await writeFile(join(dir, '.DS_Store'), 'hidden')
  return dir
}

describe('archiver app: dist of the release (DIST-1 to DIST-3)', () => {
  it('reads the build by relative path, skipping hidden files like `ipfs add -r`', async () => {
    const files = await readTree(await build())
    expect([...files.keys()].sort()).toEqual(['assets/index.js', 'index.html', SINGLE_FILE])
  })

  it('gives the CID of the whole directory and a torrent of smartcity.html seeded by the mirrors', async () => {
    const dir = await build()
    const out = await mkdtemp(join(tmpdir(), 'archiver-app-out-'))
    const lines: string[] = []
    const result = await runApp(
      { dir, out, webSeeds: ['https://smartcity-web.pages.dev/', 'https://mirror.example/app'], trackers: [] },
      (l) => lines.push(l),
    )

    expect(result.cid).toBe(directoryCid(await readTree(dir)))
    expect(result.x).toBe(createHash('sha256').update(single).digest('hex'))
    const expected = createTorrent(single, {
      name: SINGLE_FILE,
      trackers: [],
      webSeeds: ['https://smartcity-web.pages.dev/smartcity.html', 'https://mirror.example/app/smartcity.html'],
    })
    expect(result.magnet).toBe(expected.magnet)
    expect(result.magnet).toContain(`ws=${encodeURIComponent('https://smartcity-web.pages.dev/smartcity.html')}`)
    expect(result.torrent).toBe(join(out, `${SINGLE_FILE}.torrent`))
    expect(Buffer.from(await readFile(result.torrent)).equals(Buffer.from(expected.bytes))).toBe(true)
    expect(lines.join('\n')).toContain(result.cid)
  })

  it('changes the CID but not the torrent when another file of the build changes', async () => {
    const dir = await build()
    const out = await mkdtemp(join(tmpdir(), 'archiver-app-out-'))
    const before = await runApp({ dir, out, webSeeds: [] }, () => {})
    await writeFile(join(dir, 'assets', 'index.js'), 'console.log(2)')
    const after = await runApp({ dir, out, webSeeds: [] }, () => {})
    expect(after.cid).not.toBe(before.cid)
    expect(after.magnet).toBe(before.magnet)
  })

  it('fails without smartcity.html in the build', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'archiver-app-'))
    await writeFile(join(dir, 'index.html'), '<!doctype html>')
    await expect(runApp({ dir, out: dir, webSeeds: [] }, () => {})).rejects.toThrow(`no ${SINGLE_FILE}`)
  })
})
