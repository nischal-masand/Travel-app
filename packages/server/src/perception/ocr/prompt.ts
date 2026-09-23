import type { ChunkRead } from './types.ts'

/**
 * Shared across every OCR backend, so a provider swap changes who reads the
 * frames and not what they are asked for. Comparing two providers is only
 * meaningful if they were given identical instructions.
 *
 * This is a PERCEPTION step: the model transcribes glyphs and nothing else. It
 * may not infer, correct spelling, translate, or describe the scene. Anything
 * it adds here becomes "evidence" downstream, and an invented word in the
 * evidence defeats the quote check entirely — Stage B would be able to cite it
 * quite legitimately.
 */
export const PROMPT = `You are performing OCR on frames from a short social video.

For each image, transcribe ONLY the text visually burned into the frame:
overlays, captions, stickers, signage, menus, price boards.

Rules — these are absolute:
- Transcribe VERBATIM. Preserve the original spelling, capitalisation, accents,
  script (including Japanese, Korean, Thai, Arabic) and emoji exactly as shown.
- Do NOT translate. Do NOT correct spelling. Do NOT expand abbreviations.
- Do NOT describe the image, the scene, the people, or what is happening.
- Do NOT infer or complete text that is cut off — transcribe only what is legible.
- If a frame has no legible text, return an empty string for it.
- Return one entry per input image, in the order given.`

/** Single-image variant for backends that take one frame per request. */
export const PROMPT_SINGLE = `${PROMPT}

Return ONLY the transcribed text for this one image, with no commentary,
no labels and no quotation marks. If there is no legible text, return nothing.`

export const RESPONSE_SCHEMA = {
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

/** Parse a batched provider's JSON reply, tolerating fenced code blocks. */
export function parseFramesJson(raw: string, provider: string): ChunkRead[] {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '')
  let parsed: { frames?: Array<{ index?: number; text?: string }> }
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    throw new Error(`${provider} returned non-JSON for OCR:\n${raw.slice(0, 400)}`)
  }
  return (parsed.frames ?? [])
    .filter((f) => typeof f.index === 'number')
    .map((f) => ({ index: f.index as number, text: (f.text ?? '').trim() }))
}
