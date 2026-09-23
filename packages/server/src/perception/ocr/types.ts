import type { Frame } from '../media.ts'

export type OnRetry = (attempt: number, waitMs: number, err: unknown) => void

/** One frame's worth of read text, keyed back to its position in the request. */
export interface ChunkRead {
  index: number
  text: string
}

/**
 * An OCR backend.
 *
 * On-screen text is a primary evidence source — for a reel with no speech and a
 * thin caption it is the ONLY source — so depending on a single congested free
 * tier for it is a real fragility. Providers sit behind this interface so a
 * second one is a new file rather than a refactor, and so `ocr:compare` can run
 * several over identical frames and show what each actually reads.
 */
export interface OcrProvider {
  readonly name: string
  /** False when its keys are absent; the chain skips it silently. */
  readonly configured: boolean
  /**
   * How many frames this backend handles per request. Large multimodal models
   * take a batch happily; small single-image ones need 1. The caller chunks to
   * this size, so a provider never has to think about batching.
   */
  readonly framesPerRequest: number

  readChunk(frames: Frame[], onRetry?: OnRetry): Promise<ChunkRead[]>
}
