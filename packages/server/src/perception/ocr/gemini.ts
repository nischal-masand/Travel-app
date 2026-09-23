import { readFile } from 'node:fs/promises'
import { GoogleGenAI } from '@google/genai'
import { QuotaExhaustedError, withRetry } from '../../lib/retry.ts'
import { PROMPT, RESPONSE_SCHEMA, parseFramesJson } from './prompt.ts'
import type { ChunkRead, OcrProvider, OnRetry } from './types.ts'
import type { Frame } from '../media.ts'

/**
 * Free-tier availability swings hour to hour: the newest flash models are
 * routinely 503 "high demand" while a slightly older one answers in seconds.
 * And the daily quota is per MODEL, not per project — verified live, with
 * gemini-3.5-flash exhausted while four others served normally. So this is a
 * chain, and an exhausted model is a reason to step down it, not to give up.
 *
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

export const geminiOcr: OcrProvider = {
  name: 'gemini',
  get configured() {
    return Boolean(process.env.GEMINI_API_KEY)
  },
  // Large multimodal context: a batch is cheaper and lets the model see that
  // the same overlay persists across cuts.
  framesPerRequest: 6,

  async readChunk(frames: Frame[], onRetry?: OnRetry): Promise<ChunkRead[]> {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! })

    const parts: Array<Record<string, unknown>> = []
    for (const [i, f] of frames.entries()) {
      parts.push({ text: `--- image ${i} (at ${f.atSeconds.toFixed(2)}s) ---` })
      parts.push({ inlineData: { mimeType: 'image/jpeg', data: (await readFile(f.file)).toString('base64') } })
    }
    parts.push({ text: PROMPT })

    let lastErr: unknown
    for (const [i, model] of MODEL_CHAIN.entries()) {
      try {
        const res = await withRetry(
          () => ai.models.generateContent({
            model,
            contents: [{ role: 'user', parts }],
            config: {
              responseMimeType: 'application/json',
              responseSchema: RESPONSE_SCHEMA,
              temperature: 0,
            },
          }),
          { label: `gemini OCR (${model})`, model, attempts: 4, baseMs: 3000, onRetry },
        )
        return res.text ? parseFramesJson(res.text, `gemini/${model}`) : []
      } catch (err) {
        lastErr = err
        const next = MODEL_CHAIN[i + 1]
        if (!next) break
        const why = err instanceof QuotaExhaustedError ? 'out of daily quota' : 'unavailable'
        onRetry?.(0, 0, new Error(`${model} ${why} — trying ${next}`))
      }
    }

    throw new Error(
      `all gemini models failed (tried ${MODEL_CHAIN.join(', ')}): ` +
      `${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    )
  },
}
