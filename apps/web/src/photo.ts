import { ATTACHMENT_MAX_BYTES } from '@smartcity/schemas'

// PRIV-4: before a photo leaves the device the app redraws it, at most PHOTO_MAX_SIDE px on its longer side, and
// encodes it again as JPEG. The new file carries only pixels: no EXIF (location, camera, date), XMP or comments. The
// SDK strips metadata once more when it uploads it (sc.attachments.upload).

/** PRIV-4: longer side of an uploaded photo, in pixels. */
export const PHOTO_MAX_SIDE = 1600
/** JPEG qualities tried in order until the photo fits in ATTACHMENT_MAX_BYTES. */
export const PHOTO_QUALITIES = [0.85, 0.75, 0.6, 0.45] as const

/** The size of an image of `width` × `height` scaled down, keeping its aspect, so its longer side is at most `max`. */
export function fitWithin(width: number, height: number, max = PHOTO_MAX_SIDE): { width: number; height: number } {
  if (!(width > 0 && height > 0)) throw new Error('the image has no size')
  const scale = Math.min(1, max / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** The first encoding, from best quality down, that is at most `maxBytes`; rejects when none is. */
export async function encodeWithin(encode: (quality: number) => Promise<Blob>, maxBytes = ATTACHMENT_MAX_BYTES): Promise<Blob> {
  for (const quality of PHOTO_QUALITIES) {
    const blob = await encode(quality)
    if (blob.size <= maxBytes) return blob
  }
  throw new Error('La foto sigue siendo demasiado grande. Prueba con otra.')
}

/**
 * PRIV-4: a JPEG of the photo with its longer side at most PHOTO_MAX_SIDE px and no metadata. The camera's rotation
 * is applied to the pixels before its EXIF is dropped, so the photo keeps its orientation. Any image the browser can
 * decode is accepted (HEIC too, where the browser reads it). Browser only.
 */
export async function preparePhoto(file: Blob): Promise<Blob> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    throw new Error('No se pudo leer la imagen. Usa una foto JPEG, PNG o WebP.')
  }
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('El navegador no puede redimensionar la foto.')
    ctx.fillStyle = '#ffffff' // JPEG has no transparency
    ctx.fillRect(0, 0, width, height)
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, 0, 0, width, height)
    return await encodeWithin(
      (quality) =>
        new Promise<Blob>((resolve, reject) =>
          canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('No se pudo codificar la foto.'))), 'image/jpeg', quality),
        ),
    )
  } finally {
    bitmap.close()
  }
}
