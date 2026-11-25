/** 图片发给模型前的处理：超过模型有效分辨率（长边 1568px）或体积太大时缩小 */

const MAX_EDGE = 1568
const MAX_BYTES = 3.5 * 1024 * 1024
const ACCEPTED = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

export interface ImagePayload {
  media_type: string
  data: string // base64
}

function blobToBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1])
    r.onerror = reject
    r.readAsDataURL(blob)
  })
}

export async function prepareImage(blob: Blob): Promise<ImagePayload> {
  const bitmap = await createImageBitmap(blob)
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  if (scale === 1 && blob.size <= MAX_BYTES && ACCEPTED.includes(blob.type)) {
    bitmap.close()
    return { media_type: blob.type, data: await blobToBase64(blob) }
  }
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale))
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 })
  return { media_type: 'image/jpeg', data: await blobToBase64(out) }
}

export async function imageFromUrl(url: string) {
  return prepareImage(await (await fetch(url)).blob())
}
