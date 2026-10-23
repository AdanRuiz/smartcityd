import { describe, expect, it } from 'vitest'
import { PHOTO_MAX_SIDE, PHOTO_QUALITIES, encodeWithin, fitWithin } from '../src/photo'

describe('report photos (PRIV-4, PB-37)', () => {
  it('scales the longer side down to 1600 px and keeps the aspect', () => {
    expect(PHOTO_MAX_SIDE).toBe(1600)
    expect(fitWithin(4000, 3000)).toEqual({ width: 1600, height: 1200 })
    expect(fitWithin(3024, 4032)).toEqual({ width: 1200, height: 1600 })
    expect(fitWithin(1600, 900)).toEqual({ width: 1600, height: 900 })
    expect(fitWithin(20000, 10)).toEqual({ width: 1600, height: 1 })
  })

  it('never enlarges a small photo', () => {
    expect(fitWithin(640, 480)).toEqual({ width: 640, height: 480 })
  })

  it('refuses an image without size', () => {
    expect(() => fitWithin(0, 100)).toThrow()
    expect(() => fitWithin(Number.NaN, 100)).toThrow()
  })

  it('lowers the JPEG quality until the photo fits', async () => {
    const tried: number[] = []
    const blob = await encodeWithin(async (q) => {
      tried.push(q)
      return new Blob([new Uint8Array(q > 0.7 ? 300 : 100)])
    }, 200)
    expect(blob.size).toBe(100)
    expect(tried).toEqual([0.85, 0.75, 0.6])
  })

  it('rejects when no quality fits', async () => {
    const tried: number[] = []
    await expect(
      encodeWithin(async (q) => {
        tried.push(q)
        return new Blob([new Uint8Array(300)])
      }, 200),
    ).rejects.toThrow(/demasiado grande/)
    expect(tried).toEqual([...PHOTO_QUALITIES])
  })
})
