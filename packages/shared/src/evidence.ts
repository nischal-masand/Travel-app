import { z } from 'zod'

/**
 * STAGE A — PERCEPTION
 *
 * Everything in this file is *verbatim*: what was said, what was on screen, what
 * the caption contained. No inference, no summarising, no naming of places.
 * The EvidenceBundle is the auditable artifact the rest of the pipeline is
 * allowed to quote from — and nothing else.
 */

export const Platform = z.enum(['instagram', 'youtube', 'tiktok', 'manual'])
export type Platform = z.infer<typeof Platform>

export const SourceType = z.enum(['caption', 'transcript', 'onScreenText'])
export type SourceType = z.infer<typeof SourceType>

/** A single ASR word with its timing and the model's confidence in it. */
export const TranscriptWord = z.object({
  word: z.string(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  /** 0..1. Low values on a capitalised token are the signal to run ASR pass 2. */
  confidence: z.number().min(0).max(1).nullable(),
})
export type TranscriptWord = z.infer<typeof TranscriptWord>

export const Transcript = z.object({
  text: z.string(),
  words: z.array(TranscriptWord),
  language: z.string().nullable(),
  /** Which pass produced this: 1 = cold, 2 = biased by the vocabulary. */
  pass: z.union([z.literal(1), z.literal(2)]),
  /** The proper-noun vocabulary fed to pass 2, kept for debugging the biasing. */
  vocabulary: z.array(z.string()).default([]),
})
export type Transcript = z.infer<typeof Transcript>

/** Text read off a frame. `frameRef` is a file in the capture's working dir. */
export const OnScreenText = z.object({
  text: z.string(),
  atSeconds: z.number().nonnegative(),
  frameRef: z.string(),
})
export type OnScreenText = z.infer<typeof OnScreenText>

export const Caption = z.object({
  text: z.string(),
  hashtags: z.array(z.string()).default([]),
  /** Instagram's own location tag, when the creator set one. Highly reliable. */
  locationTag: z.string().nullable().default(null),
})
export type Caption = z.infer<typeof Caption>

export const EvidenceBundle = z.object({
  captureId: z.string(),
  platform: Platform,
  url: z.string(),
  author: z.string().nullable().default(null),
  postedAt: z.string().nullable().default(null),

  caption: Caption,
  /**
   * Null for a capture with no audio at all — a carousel or a still post.
   * That is a NORMAL capture, not a failure. Caption + OCR carry it.
   */
  transcript: Transcript.nullable(),
  /** The pass that was NOT chosen, kept so the decision can be audited. */
  transcriptPass1: Transcript.nullable().default(null),
  onScreenText: z.array(OnScreenText).default([]),
  /**
   * Frames the OCR stage could not read (provider unavailable after retries).
   * Surfaced rather than swallowed: on-screen text is a primary evidence
   * source, so a partial read has to be visible to whoever judges the output.
   */
  ocrFailedFrames: z.number().int().nonnegative().default(0),

  /** Where the transcribed audio came from, for debugging silent captures. */
  audioSource: z.enum(['video', 'separate', 'none']).default('none'),
  /**
   * Why transcription was skipped, when it was. Most often: the post uses a
   * borrowed music track, so there is no speech — and transcribing the song
   * would put its lyrics into the evidence as if someone had said them.
   */
  skippedAsrReason: z.string().nullable().default(null),
  /** Which ASR pass was kept and why, when a second pass ran. */
  biasVerdict: z.string().nullable().default(null),
  /**
   * Written terms too weak to bias ASR with (lowercase topic hashtags), but
   * useful in Stage B for corroborating a name heard in the audio.
   */
  corroborationTerms: z.array(z.string()).default([]),
  durationSeconds: z.number().nonnegative().nullable().default(null),
  /** Carousel slides / still images, as local paths. */
  imageRefs: z.array(z.string()).default([]),
  createdAt: z.string(),
})
export type EvidenceBundle = z.infer<typeof EvidenceBundle>

/**
 * The searchable text of a bundle, per source. This is the ONLY text the
 * interpretation stage ever sees, and the exact corpus that `sourceQuote`
 * values are checked against.
 */
export function evidenceTexts(bundle: EvidenceBundle): Record<SourceType, string> {
  return {
    caption: [bundle.caption.text, ...bundle.caption.hashtags, bundle.caption.locationTag ?? '']
      .filter(Boolean)
      .join('\n'),
    transcript: bundle.transcript?.text ?? '',
    onScreenText: bundle.onScreenText.map((o) => o.text).join('\n'),
  }
}
