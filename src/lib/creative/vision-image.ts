import type { AiImage } from '@/lib/ai'
import { fetchTrustedMetaImage } from '@/lib/report/trusted-meta-image'

export class VisionImageUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`vision image unavailable: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'VisionImageUnavailableError'
  }
}

/**
 * Fetch a creative image from an approved Meta CDN host for a vision request.
 *
 * A text-only answer recorded for an image analysis would enter the immutable vision version ledger
 * indistinguishable from an image-grounded one (the version identity carries no modality), so an
 * unavailable image must FAIL the analysis before any model call; the creative stays pending for a
 * later run.
 */
export async function loadVisionImage(imageUrl: string): Promise<AiImage> {
  try {
    const image = await fetchTrustedMetaImage(imageUrl)
    return { mediaType: image.mediaType, base64: image.bytes.toString('base64') }
  } catch (err) {
    throw new VisionImageUnavailableError(err)
  }
}
