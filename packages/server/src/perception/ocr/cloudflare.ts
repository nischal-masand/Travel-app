import { readFile } from 'node:fs/promises'
import { withRetry } from '../../lib/retry.ts'
import { PROMPT_SINGLE } from './prompt.ts'
import type { ChunkRead, OcrProvider, OnRetry } from './types.ts'
import type { Frame } from '../media.ts'

/**
 * Cloudflare Workers AI — a second OCR provider, so on-screen text does not
 * depend on one congested free tier. No credit card, no phone verification,
 * 10,000 neurons/day.
 *
 * The model was chosen by measurement, on the hardest reel available: stylised
 * bilingual overlays ("This is still Kyoto / ここも、京都") where the ONLY mention
 * of one place ("Beach Swing Yurari") is text on a frame.
 *
 *   Qwen 3.8 27B     read "Beach Swing Yurari"; slipped one Japanese character
 *                    ("こことも" for "ここも").                          ← chosen
 *   Llama 4 Scout    Japanese perfect, but MISSED "Beach Swing Yurari".
 *   Gemma 4 26B      returned nothing on two of three frames.
 *   Moondream 3.1    returns {} for every input, even text-only questions,
 *                    while other models on the same account answer — broken.
 *
 * Qwen wins because the place name is what OCR is for here; a slip in the
 * surrounding Japanese costs little. It is still a fallback, not an equal: an
 * OCR error becomes "evidence" the quote check will happily verify against, so
 * Gemini stays first. Run `npm run ocr:compare -- <url>` before trusting it on a
 * new kind of reel.
 */
const MODEL = process.env.CLOUDFLARE_OCR_MODEL || '@cf/qwen/qwen3.8-27b'

export const cloudflareOcr: OcrProvider = {
  name: 'cloudflare',
  get configured() {
    return Boolean(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN)
  },
  // One frame per request: measured per-frame, and a batch that fails loses
  // every frame in it at once.
  framesPerRequest: 1,

  async readChunk(frames: Frame[], onRetry?: OnRetry): Promise<ChunkRead[]> {
    const frame = frames[0]
    if (!frame) return []

    const account = process.env.CLOUDFLARE_ACCOUNT_ID!
    const url = `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1/chat/completions`
    const b64 = (await readFile(frame.file)).toString('base64')

    const res = await withRetry(
      async () => {
        const r = await fetch(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: MODEL,
            temperature: 0,
            messages: [{
              role: 'user',
              content: [
                { type: 'text', text: PROMPT_SINGLE },
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } },
              ],
            }],
          }),
          signal: AbortSignal.timeout(90_000),
        })
        if (!r.ok) {
          const body = await r.text().catch(() => '')
          // Surface the status so isRetryable/isQuotaExhausted can classify it.
          throw Object.assign(new Error(`Cloudflare ${r.status}: ${body.slice(0, 200)}`), { status: r.status })
        }
        return r.json() as Promise<{ choices?: Array<{ message?: { content?: string } }> }>
      },
      { label: `cloudflare OCR (${MODEL})`, model: MODEL, attempts: 3, baseMs: 2000, onRetry },
    )

    const text = (res.choices?.[0]?.message?.content ?? '').trim()
    // A single-image model has no JSON contract, so guard against it answering
    // "there is no text in this image" in prose instead of returning nothing.
    if (!text || /^(none|no text|n\/a|empty)\b/i.test(text)) return [{ index: 0, text: '' }]
    return [{ index: 0, text }]
  },
}
