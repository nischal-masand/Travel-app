import { createReadStream } from 'node:fs'
import Groq from 'groq-sdk'
import type { Transcript, TranscriptWord } from '@reel/shared'
import { env } from '../lib/env.ts'
import { withRetry } from '../lib/retry.ts'

const MODEL = process.env.GROQ_ASR_MODEL || 'whisper-large-v3'

interface VerboseWord { word: string; start: number; end: number }
interface VerboseSegment { start: number; end: number; avg_logprob?: number; no_speech_prob?: number }
interface VerboseResponse {
  text: string
  language?: string
  words?: VerboseWord[]
  segments?: VerboseSegment[]
}

/**
 * Whisper does not emit a true per-word probability through the OpenAI-shaped
 * API — only `avg_logprob` per segment. So word confidence here is that
 * segment's score, exponentiated into a 0..1 proxy and attributed to every word
 * inside it. It is good enough for its one job: spotting shaky capitalised
 * tokens that should trigger a biased second pass. It is not a calibrated
 * probability and shouldn't be shown to users as one.
 */
function wordConfidences(res: VerboseResponse): TranscriptWord[] {
  const segments = res.segments ?? []
  const scoreAt = (t: number): number | null => {
    const seg = segments.find((s) => t >= s.start && t <= s.end) ?? segments.at(-1)
    if (!seg || seg.avg_logprob === undefined) return null
    return Math.min(1, Math.max(0, Math.exp(seg.avg_logprob)))
  }

  return (res.words ?? []).map((w) => ({
    word: w.word,
    startMs: Math.round(w.start * 1000),
    endMs: Math.round(w.end * 1000),
    confidence: scoreAt(w.start),
  }))
}

export type OnRetry = (attempt: number, waitMs: number, err: unknown) => void

async function transcribeOnce(
  audioPath: string,
  pass: 1 | 2,
  vocabulary: string[],
  onRetry?: OnRetry,
): Promise<Transcript> {
  const groq = new Groq({ apiKey: env.groqKey })

  // Whisper's `prompt` conditions decoding as if it were the preceding
  // transcript, so a bare comma-separated list is the shape that biases best.
  // Groq caps it at 224 tokens; buildVocabulary already keeps us under that.
  const prompt = vocabulary.length
    ? `Place names and proper nouns mentioned: ${vocabulary.join(', ')}.`
    : undefined

  // A fresh read stream per attempt: a consumed stream cannot be replayed.
  const res = (await withRetry(
    () => groq.audio.transcriptions.create({
      file: createReadStream(audioPath),
      model: MODEL,
      response_format: 'verbose_json',
      timestamp_granularities: ['word', 'segment'],
      temperature: 0,
      ...(prompt ? { prompt } : {}),
    }),
    { label: `Groq ASR pass ${pass} (${MODEL})`, onRetry },
  )) as unknown as VerboseResponse

  return {
    text: (res.text ?? '').trim(),
    words: wordConfidences(res),
    language: res.language ?? null,
    pass,
    vocabulary,
  }
}

export const transcribeCold = (audioPath: string, onRetry?: OnRetry) =>
  transcribeOnce(audioPath, 1, [], onRetry)
export const transcribeBiased = (audioPath: string, vocabulary: string[], onRetry?: OnRetry) =>
  transcribeOnce(audioPath, 2, vocabulary, onRetry)
