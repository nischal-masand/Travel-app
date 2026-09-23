import { readFile } from 'node:fs/promises'
import { GoogleGenAI } from '@google/genai'
import type { OnScreenText } from '@reel/shared'
import { env } from '../lib/env.ts'
import { QuotaExhaustedError, withRetry } from '../lib/retry.ts'
import type { Frame } from './media.ts'

/**
 * Free-tier model availability swings day to day — the newest flash models are
 * routinely 503 "high demand" while a slightly older one answers in seconds.
 * So this is a chain, not a single name: the first model that responds wins.
 * Set GEMINI_MODEL in .env to force one to the front.
 */
const MODEL_CHAIN = [
  ...(process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL] : []),
  'gemini-3.5-flash',
  'gemini-3-flash-preview',
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
  'gemini-flash-lite-latest',
].filter((m, i, all) => all.indexOf(m) === i)

/**
 * Frames per request. Small batches get served far more readily than one large
 * multimodal call when the free tier is congested, and a failure then costs one
 * chunk of frames instead of the whole capture.
 */
const CHUNK = 6

/**
 * Reads the text burned into the frames. This is a PERCEPTION step: the model
 * transcribes glyphs and nothing else. It may not infer, correct spelling,
 * translate, or describe the scene — anything it adds here becomes "evidence"
 * downstream and would defeat the whole point of the quote check.
 *
 * On-screen text matters more than it looks: travel reels caption their place
 * names on screen, and a written name is spelled correctly, unlike ASR's guess
 * at it. This is one of the two sources that can out-vote the transcript.
 */
const PROMPT = `You are performing OCR on frames from a short social video.

For each image, transcribe ONLY the text visually burned into the frame:
overlays, captions, stickers, signage, menus, price boards.

Rules — these are absolute:
- Transcribe VERBATIM. Preserve the original spelling, capitalisation, accents
  and emoji exactly as they appear.
- Do NOT translate. Do NOT correct spelling. Do NOT expand abbreviations.
- Do NOT describe the image, the scene, the people, or what is happening.
- Do NOT infer or complete text that is cut off — transcribe only what is legible.
- If a frame has no legible text, return an empty string for it.
- Return one entry per input image, in the order given.`

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    frames: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          text: { type: 'string' },
        },
        required: ['index', 'text'],
      },
    },
  },
  required: ['frames'],
} as const

export type OnRetry = (attempt: number, waitMs: number, err: unknown) => void

export interface OcrResult {
  texts: OnScreenText[]
  /** Frames in chunks that never succeeded. Reported, never silently dropped. */
  failedFrames: number
}

export async function readOnScreenText(frames: Frame[], onRetry?: OnRetry): Promise<OcrResult> {
  if (frames.length === 0) return { texts: [], failedFrames: 0 }
  // OCR_ENGINE=none runs the pipeline on caption + audio alone. Useful when the
  // daily quota is gone and you still want to test the rest of Stage A.
  if (process.env.OCR_ENGINE === 'none') return { texts: [], failedFrames: frames.length }

  const ai = new GoogleGenAI({ apiKey: env.geminiKey })
  const texts: OnScreenText[] = []
  let failedFrames = 0

  for (let start = 0; start < frames.length; start += CHUNK) {
    const chunk = frames.slice(start, start + CHUNK)
    try {
      texts.push(...(await readChunk(ai, chunk, onRetry)))
    } catch (err) {
      // Soft-fail: keep the frames we did read. The count travels with the
      // bundle so a partial read is never mistaken for "no text on screen".
      failedFrames += chunk.length
      onRetry?.(0, 0, new Error(`gave up on ${chunk.length} frames: ${err instanceof Error ? err.message.slice(0, 80) : err}`))
    }
  }

  return { texts: dedupeConsecutive(texts), failedFrames }
}

async function readChunk(
  ai: GoogleGenAI,
  frames: Frame[],
  onRetry?: OnRetry,
): Promise<OnScreenText[]> {
  const parts: Array<Record<string, unknown>> = []
  for (const [i, f] of frames.entries()) {
    parts.push({ text: `--- image ${i} (at ${f.atSeconds.toFixed(2)}s) ---` })
    parts.push({ inlineData: { mimeType: 'image/jpeg', data: (await readFile(f.file)).toString('base64') } })
  }
  parts.push({ text: PROMPT })

  let res: Awaited<ReturnType<typeof ai.models.generateContent>> | null = null
  let lastErr: unknown

  for (const [i, model] of MODEL_CHAIN.entries()) {
    try {
      res = await withRetry(
        () => ai.models.generateContent({
          model,
          contents: [{ role: 'user', parts }],
          config: {
            responseMimeType: 'application/json',
            responseSchema: RESPONSE_SCHEMA,
            temperature: 0,
          },
        }),
        { label: `Gemini OCR (${model})`, model, attempts: 4, baseMs: 3000, onRetry },
      )
      break
    } catch (err) {
      lastErr = err
      const next = MODEL_CHAIN[i + 1]
      if (!next) break
      // Quota is per MODEL, so an exhausted one is a reason to move down the
      // chain immediately (no point retrying it) rather than to give up.
      const why = err instanceof QuotaExhaustedError ? 'out of daily quota' : 'unavailable'
      onRetry?.(0, 0, new Error(`${model} ${why} — trying ${next}`))
    }
  }

  if (!res) {
    throw new Error(
      `all models unavailable (tried ${MODEL_CHAIN.join(', ')}): ` +
      `${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    )
  }

  const raw = res.text
  if (!raw) return []

  let parsed: { frames?: Array<{ index?: number; text?: string }> }
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`Gemini returned non-JSON for OCR:
${raw.slice(0, 500)}`)
  }

  const out: OnScreenText[] = []
  for (const entry of parsed.frames ?? []) {
    const frame = frames[entry.index ?? -1]
    const text = (entry.text ?? '').trim()
    if (!frame || !text) continue
    out.push({ text, atSeconds: frame.atSeconds, frameRef: frame.file })
  }
  return out
}

/**
 * Overlay text lingers across several scene cuts, so the same words come back
 * frame after frame. Keep the first sighting (the earliest timestamp is the one
 * worth linking the user to) and drop the repeats.
 */
function dedupeConsecutive(items: OnScreenText[]): OnScreenText[] {
  const seen = new Set<string>()
  const out: OnScreenText[] = []
  for (const item of items) {
    const key = item.text.replace(/\s+/g, ' ').trim().toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}
