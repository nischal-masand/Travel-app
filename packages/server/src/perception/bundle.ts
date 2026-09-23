import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { EvidenceBundle } from '@reel/shared'
import { resolverFor } from '../resolvers/index.ts'
import { captureIdFor, workdirFor } from '../lib/workdir.ts'
import { extractAudio, extractFrames, hasAudioStream, probeDuration, type Frame } from './media.ts'
import { readOnScreenText } from './ocr/index.ts'
import { transcribeBiased, transcribeCold } from './asr.ts'
import { buildVocabulary, chooseTranscript, secondPassReason } from './vocabulary.ts'

export type Progress = (step: string, detail?: string) => void

/**
 * STAGE A — builds the evidence bundle and nothing more.
 *
 * Every field here is verbatim. Nothing in this file decides what a place is,
 * and no model is asked to conclude anything. That separation is the whole
 * reason the quote check downstream can actually catch an invented café.
 */
export async function buildEvidence(url: string, onProgress: Progress = () => {}): Promise<EvidenceBundle> {
  const captureId = captureIdFor(url)
  const workdir = await workdirFor(captureId)

  // --- A0: resolve -----------------------------------------------------------
  const resolver = resolverFor(url)
  onProgress('resolve', resolver.name)
  const media = await resolver.resolve(url, workdir)

  // --- frames + audio --------------------------------------------------------
  let frames: Frame[] = []
  let audioPath: string | null = null
  let audioSource: 'video' | 'separate' | 'none' = 'none'
  let skippedAsrReason: string | null = null
  let durationSeconds: number | null = null

  if (media.videoPath) {
    durationSeconds = await probeDuration(media.videoPath)
    onProgress('frames', `${durationSeconds?.toFixed(1) ?? '?'}s video`)
    frames = await extractFrames(media.videoPath, workdir)

    if (await hasAudioStream(media.videoPath)) {
      audioPath = await extractAudio(media.videoPath, workdir)
      audioSource = 'video'
    } else if (media.separateAudioPath) {
      // Instagram's DASH delivery splits the streams, so a video file with no
      // audio track does NOT mean a silent reel.
      audioPath = await extractAudio(media.separateAudioPath, workdir)
      audioSource = 'separate'
      onProgress('audio', 'used the separate DASH audio stream')
    } else {
      onProgress('audio', 'no audio stream anywhere — caption + OCR only')
    }
  }

  // A borrowed music track carries no spoken claims. Transcribing it would put
  // song lyrics into the evidence bundle, and Stage B would then be free to
  // quote a lyric as the source for a place that was never mentioned.
  if (audioPath && media.usesOriginalAudio === false) {
    skippedAsrReason = 'post uses a licensed music track, not original audio — no speech to transcribe'
    onProgress('asr', 'skipped: ' + skippedAsrReason)
    audioPath = null
  }

  // A carousel or still post has no audio at all. That is a normal capture:
  // the caption and the slides carry it. Treat each slide as a frame at 0s.
  if (media.imagePaths.length > 0) {
    frames = [...frames, ...media.imagePaths.map((file) => ({ file, atSeconds: 0 }))]
  }

  // --- A2 pass 1 and A3 run independently, so run them together --------------
  onProgress('perceive', `${frames.length} frames${audioPath ? ' + audio' : ''}`)
  const retryNote = (what: string) => (attempt: number, waitMs: number, err: unknown) =>
    onProgress('retry', `${what} attempt ${attempt} — ${(waitMs / 1000).toFixed(1)}s (${short(err)})`)

  const [ocr, pass1] = await Promise.all([
    frames.length
      ? readOnScreenText(frames, retryNote('ocr'))
      : Promise.resolve({ texts: [], failedFrames: 0, provider: null }),
    audioPath ? transcribeCold(audioPath, retryNote('asr:1')) : Promise.resolve(null),
  ])
  const onScreenText = ocr.texts
  onProgress('ocr', `${onScreenText.length} regions via ${ocr.provider ?? 'none'}${ocr.failedFrames ? ` (${ocr.failedFrames} frames unread)` : ''}`)
  if (pass1) onProgress('asr:1', `${pass1.words.length} words`)

  // --- A2 pass 2: biased by everything that spells correctly -----------------
  const vocabulary = buildVocabulary({ caption: media.caption, onScreenText })
  let transcript = pass1
  let transcriptPass1 = null as typeof pass1
  let biasVerdict: string | null = null

  const reason = audioPath && pass1 ? secondPassReason(pass1, vocabulary.bias) : null
  if (audioPath && pass1 && reason) {
    onProgress('asr:2', reason)
    const pass2 = await transcribeBiased(audioPath, vocabulary.bias, retryNote('asr:2'))

    // Do not assume pass 2 won. Biasing can also push Whisper into mangling a
    // name it had right the first time, so compare and keep the better one.
    const decision = chooseTranscript(pass1, pass2, vocabulary.bias)
    transcript = decision.chosen
    transcriptPass1 = decision.chosen === pass1 ? pass2 : pass1
    biasVerdict = decision.verdict
    onProgress('asr:pick', decision.verdict)
  }

  const bundle = EvidenceBundle.parse({
    captureId,
    platform: media.platform,
    url: media.url,
    author: media.author,
    postedAt: media.postedAt,
    caption: media.caption,
    transcript,
    transcriptPass1,
    onScreenText,
    ocrFailedFrames: ocr.failedFrames,
    ocrProvider: ocr.provider,
    audioSource,
    skippedAsrReason,
    biasVerdict,
    corroborationTerms: vocabulary.corroboration,
    durationSeconds,
    imageRefs: media.imagePaths,
    createdAt: new Date().toISOString(),
  })

  const out = path.join(workdir, 'evidence.json')
  await writeFile(out, JSON.stringify(bundle, null, 2))
  onProgress('done', out)

  return bundle
}

/** Trim a provider error down to something that fits on a progress line. */
function short(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  const api = msg.match(/"message"\s*:\s*"([^"]+)"/)
  return (api?.[1] ?? msg).replace(/\s+/g, ' ').slice(0, 70)
}
