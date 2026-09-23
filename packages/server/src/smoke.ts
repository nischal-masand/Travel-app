/**
 * Offline smoke test for the parts of Stage A that need no API keys:
 * frame extraction, scene detection, audio extraction, and vocabulary biasing.
 *
 * ffmpeg's filter syntax is colon-delimited, which collides with Windows drive
 * letters, so this exercises the real filter strings on a synthetic clip rather
 * than trusting that they parse.
 *
 *   npm run smoke -w @reel/server
 */
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ffmpeg } from './lib/exec.ts'
import { extractAudio, extractFrames, hasAudioStream, probeDuration } from './perception/media.ts'
import { buildVocabulary, chooseTranscript, secondPassReason } from './perception/vocabulary.ts'
import { QuotaExhaustedError, isQuotaExhausted, isRetryable } from './lib/retry.ts'
import type { Transcript } from '@reel/shared'

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`)
  if (!ok) failures++
}

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), 'reel-smoke-'))
  await mkdir(path.join(dir, 'frames'), { recursive: true })
  const video = path.join(dir, 'video.mp4')

  // Three hard cuts over 6s, plus a tone, so scene detection has something real
  // to find and the audio path has something to extract.
  await ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=2',
    '-f', 'lavfi', '-i', 'color=c=red:size=640x360:rate=25:duration=2',
    '-f', 'lavfi', '-i', 'color=c=blue:size=640x360:rate=25:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
    // -color_range tv makes this limited-range YUV, which is what real video
    // off YouTube and Instagram actually is. Full-range test clips hid a bug
    // where ffmpeg's mjpeg encoder refuses limited-range input outright.
    '-map', '[v]', '-map', '3:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-color_range', 'tv', '-c:a', 'aac',
    video,
  ])

  const duration = await probeDuration(video)
  check('probeDuration', duration !== null && Math.abs(duration - 6) < 0.5, `${duration?.toFixed(2)}s`)

  check('hasAudioStream', await hasAudioStream(video))

  const frames = await extractFrames(video, dir)
  check('extractFrames returns frames', frames.length > 0, `${frames.length} frames`)
  check('frames have distinct timestamps', new Set(frames.map((f) => f.atSeconds)).size > 1,
    frames.map((f) => f.atSeconds.toFixed(2)).join(', '))
  check('frame timestamps within duration', frames.every((f) => f.atSeconds <= (duration ?? 0) + 0.5))

  const audio = await extractAudio(video, dir)
  check('extractAudio', (await probeDuration(audio)) !== null, path.basename(audio))


  // --- scene detection proper ---------------------------------------------
  // The clip above has only two cuts, so it falls through to interval
  // sampling. Scene detection is the riskier path (it parses `pts_time` out of
  // ffmpeg's stdout), so give it a clip with enough cuts to stand on its own.
  const sceneDir = path.join(dir, 'scenes')
  await mkdir(path.join(sceneDir, 'frames'), { recursive: true })
  const sceneVideo = path.join(sceneDir, 'video.mp4')
  const colours = ['red', 'green', 'blue', 'yellow', 'magenta', 'cyan', 'white', 'black']
  await ffmpeg([
    ...colours.flatMap((c) => ['-f', 'lavfi', '-i', `color=c=${c}:size=320x180:rate=25:duration=1`]),
    '-filter_complex', `${colours.map((_, i) => `[${i}:v]`).join('')}concat=n=${colours.length}:v=1:a=0[v]`,
    '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-color_range', 'tv',
    sceneVideo,
  ])
  const sceneFrames = await extractFrames(sceneVideo, sceneDir)
  const onSceneCuts = sceneFrames.every((f) => Math.abs(f.atSeconds - Math.round(f.atSeconds)) < 0.25)
  check('scene detection path used (not interval fallback)', sceneFrames.length >= 4, `${sceneFrames.length} frames`)
  check('pts_time parsed from ffmpeg stdout', sceneFrames.some((f) => f.atSeconds > 0),
    sceneFrames.map((f) => f.atSeconds.toFixed(2)).join(', '))
  check('frames land on the actual cuts', onSceneCuts)

  // --- vocabulary: the piece that turns "noosa peneeda" into "Nusa Penida" ---
  const vocab = buildVocabulary({
    caption: {
      text: 'Nusa Penida day trip! We loved Kelingking Beach and Diamond Beach. Every warung here is good. The best is Warung Gula Bali.',
      hashtags: ['NusaPenida', 'balitravel', 'Kelingking_Beach'],
      locationTag: 'Nusa Penida, Bali',
    },
    onScreenText: [{ text: 'Angel Billabong', atSeconds: 3, frameRef: 'x.jpg' }],
  })
  check('vocabulary finds multi-word place names', vocab.bias.includes('Nusa Penida'), vocab.bias.slice(0, 6).join(' | '))
  check('vocabulary reads on-screen text', vocab.bias.includes('Angel Billabong'))
  check('vocabulary splits CamelCase hashtags', vocab.bias.includes('Kelingking Beach'))
  check('vocabulary prefers longer phrases first', (vocab.bias[0]?.split(' ').length ?? 0) >= 2, 'first: ' + vocab.bias[0])

  // Junk filtering. Both of these actively corrupted a real transcript before
  // they were excluded, so they are regression guards, not style points.
  check('drops single capitals that merely open a sentence',
    !vocab.bias.includes('Every') && !vocab.bias.includes('The') && !vocab.bias.includes('We'),
    vocab.bias.filter((v) => !v.includes(' ')).join(' | ') || '(no single-word terms)')
  check('keeps topic hashtags OUT of the ASR bias list',
    !vocab.bias.some((v) => v.toLowerCase() === 'balitravel'))
  check('but keeps them for Stage B corroboration',
    vocab.corroboration.includes('balitravel'), vocab.corroboration.join(' | '))

  // --- pass-2 trigger ------------------------------------------------------
  // Whisper's segment confidence sits at 0.90-0.91 across an ENTIRE transcript,
  // so it cannot single out a mangled proper noun. The trigger is instead
  // 'a name we know about is missing from the transcript'.
  const mangled: Transcript = {
    text: 'we went to noosa peneeda and it was amazing', pass: 1, language: 'en', vocabulary: [],
    words: [{ word: 'Noosa', startMs: 0, endMs: 400, confidence: 0.9 }],
  }
  const fixed: Transcript = { ...mangled, pass: 2, text: 'we went to Nusa Penida and it was amazing' }

  check('secondPassReason fires when a known name is absent',
    secondPassReason(mangled, ['Nusa Penida']) !== null)
  check('secondPassReason quiet once the name is present',
    secondPassReason(fixed, ['Nusa Penida']) === null)
  check('secondPassReason quiet with no vocabulary', secondPassReason(mangled, []) === null)
  check('secondPassReason quiet on empty transcript',
    secondPassReason({ ...mangled, text: '' }, ['Nusa Penida']) === null)
  check('lowercase hashtag matches spaced speech',
    secondPassReason({ ...mangled, text: 'we drank in Golden Gai all night' }, ['goldengai']) === null)

  // --- pass selection: the guard against biasing making things WORSE -------
  // A real capture turned a correct 'Matching Planet' into 'Mac-shun Planet'.
  const good: Transcript = { ...mangled, text: 'I run Matching Planet, a travel company' }
  const worse: Transcript = { ...good, pass: 2, text: 'I run Mac-shun Planet, a travel company' }

  check('keeps pass 2 when it recovers a name',
    chooseTranscript(mangled, fixed, ['Nusa Penida']).chosen === fixed)
  check('REJECTS pass 2 when it loses a name it had',
    chooseTranscript(good, worse, ['Matching Planet']).chosen === good,
    chooseTranscript(good, worse, ['Matching Planet']).verdict)
  check('keeps pass 1 when pass 2 changes nothing known',
    chooseTranscript(good, { ...good, pass: 2 }, ['Matching Planet']).chosen === good)

  // --- retry semantics -----------------------------------------------------
  // A daily quota and a per-minute rate limit are both 429 but need opposite
  // handling: wait out the second, never retry the first.
  const quota = { message: 'You exceeded your current quota, please check your plan and billing details' }
  const busy = { status: 503, message: 'This model is currently experiencing high demand' }
  check('recognises a daily quota 429', isQuotaExhausted(quota))
  check('a quota error is NOT retryable', !isRetryable(quota))
  check('a 503 overload IS retryable', isRetryable(busy))
  check('quota error names the model so the caller can skip it',
    new QuotaExhaustedError('detail', 'gemini-3.5-flash').message.includes('gemini-3.5-flash'))

  await rm(dir, { recursive: true, force: true })
  console.log(failures === 0 ? '\n\x1b[32mall good\x1b[0m' : `\n\x1b[31m${failures} failed\x1b[0m`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
