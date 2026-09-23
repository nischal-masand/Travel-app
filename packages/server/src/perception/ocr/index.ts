import type { OnScreenText } from '@reel/shared'
import type { Frame } from '../media.ts'
import { cloudflareOcr } from './cloudflare.ts'
import { geminiOcr } from './gemini.ts'
import type { OcrProvider, OnRetry } from './types.ts'

export type { OcrProvider, OnRetry } from './types.ts'
export { geminiOcr } from './gemini.ts'
export { cloudflareOcr } from './cloudflare.ts'

/** Preference order. Unconfigured providers are skipped silently. */
export const PROVIDERS: OcrProvider[] = [geminiOcr, cloudflareOcr]

export function activeProviders(): OcrProvider[] {
  const only = process.env.OCR_PROVIDER
  const configured = PROVIDERS.filter((p) => p.configured)
  return only ? configured.filter((p) => p.name === only) : configured
}

export interface OcrResult {
  texts: OnScreenText[]
  /** Frames no provider could read. Reported, never silently dropped. */
  failedFrames: number
  /** Which provider actually produced the text, for the report. */
  provider: string | null
}

/**
 * Reads the text burned into the frames, falling across providers as needed.
 *
 * Chunking, deduplication and soft-failure live here rather than in each
 * provider, so every backend gets identical treatment and comparing two of them
 * measures the model rather than the plumbing.
 */
export async function readOnScreenText(frames: Frame[], onRetry?: OnRetry): Promise<OcrResult> {
  if (frames.length === 0) return { texts: [], failedFrames: 0, provider: null }
  // OCR_ENGINE=none runs the pipeline on caption + audio alone — useful when
  // every provider's daily quota is gone and you still want to test Stage A.
  if (process.env.OCR_ENGINE === 'none') {
    return { texts: [], failedFrames: frames.length, provider: null }
  }

  const providers = activeProviders()
  if (providers.length === 0) {
    throw new Error(
      'No OCR provider configured. Set GEMINI_API_KEY, or CLOUDFLARE_ACCOUNT_ID + ' +
      'CLOUDFLARE_API_TOKEN, or OCR_ENGINE=none to skip on-screen text entirely.',
    )
  }

  for (const [i, provider] of providers.entries()) {
    const result = await readWith(provider, frames, onRetry)
    // Partial output still beats nothing, but a provider that read NOTHING at
    // all is a provider that is down — try the next one before accepting it.
    if (result.texts.length > 0 || result.failedFrames === 0) return result

    const next = providers[i + 1]
    if (next) onRetry?.(0, 0, new Error(`${provider.name} read nothing — trying ${next.name}`))
    else return result
  }

  return { texts: [], failedFrames: frames.length, provider: null }
}

async function readWith(provider: OcrProvider, frames: Frame[], onRetry?: OnRetry): Promise<OcrResult> {
  const texts: OnScreenText[] = []
  let failedFrames = 0
  const size = Math.max(1, provider.framesPerRequest)

  for (let start = 0; start < frames.length; start += size) {
    const chunk = frames.slice(start, start + size)
    try {
      for (const read of await provider.readChunk(chunk, onRetry)) {
        const frame = chunk[read.index]
        if (!frame || !read.text) continue
        texts.push({ text: read.text, atSeconds: frame.atSeconds, frameRef: frame.file })
      }
    } catch (err) {
      failedFrames += chunk.length
      const why = err instanceof Error ? err.message.slice(0, 90) : String(err)
      onRetry?.(0, 0, new Error(`${provider.name} gave up on ${chunk.length} frame(s): ${why}`))
    }
  }

  return { texts: dedupeRepeats(texts), failedFrames, provider: provider.name }
}

/**
 * Overlay text lingers across several scene cuts, so the same words come back
 * frame after frame. Keep the first sighting — the earliest timestamp is the
 * one worth linking the user to — and drop the repeats.
 */
function dedupeRepeats(items: OnScreenText[]): OnScreenText[] {
  const seen = new Set<string>()
  const out: OnScreenText[] = []
  for (const item of items) {
    const k = item.text.replace(/\s+/g, ' ').trim().toLowerCase()
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(item)
  }
  return out
}
