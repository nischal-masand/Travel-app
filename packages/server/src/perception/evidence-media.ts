import { access, mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'
import { ffmpeg } from '../lib/exec.ts'
import { workdirFor } from '../lib/workdir.ts'

/**
 * Cuts the proof out of the stored video: the frame at a moment, and a few
 * seconds of audio around it.
 *
 * This exists because "couldn't recognise the name — check 0:14" is useless on
 * Instagram, where seeking inside a reel is genuinely tedious. The server still
 * has the video, so the evidence comes to you instead: you see the frame and
 * hear the line without reopening the app you saved it from.
 */

const CLIP_PAD_SECONDS = 1.5

async function exists(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

/** Cut evidence lives beside the capture's media, in its own folder. */
async function evidenceDir(workdir: string): Promise<string> {
  const dir = path.join(workdir, 'evidence')
  await mkdir(dir, { recursive: true })
  return dir
}

async function sourceVideo(workdir: string): Promise<string | null> {
  const files = await readdir(workdir).catch(() => [])
  const video = files.find((f) => /^video\.(mp4|mkv|webm|mov)$/i.test(f))
  return video ? path.join(workdir, video) : null
}

/**
 * A still at `atSeconds`. Cut on demand and kept, because the same moment is
 * requested every time the card is opened.
 */
export async function frameAt(captureId: string, atSeconds: number): Promise<string | null> {
  const workdir = await workdirFor(captureId)
  const stamp = atSeconds.toFixed(2).replace('.', '_')
  const dest = path.join(await evidenceDir(workdir), `frame-${stamp}.jpg`)
  if (await exists(dest)) return dest

  const video = await sourceVideo(workdir)
  // A carousel has no video; its slides already are the evidence.
  if (!video) return firstImage(workdir)

  await ffmpeg([
    // -ss before -i seeks by keyframe, which is fast and close enough for a
    // still meant to be read rather than frame-matched.
    '-ss', String(Math.max(0, atSeconds)),
    '-i', video,
    '-frames:v', '1', '-q:v', '3', '-pix_fmt', 'yuvj420p',
    dest,
  ])
  return (await exists(dest)) ? dest : null
}

async function firstImage(workdir: string): Promise<string | null> {
  const files = await readdir(workdir).catch(() => [])
  const image = files.find((f) => /^image-\d+\.jpg$/i.test(f))
  return image ? path.join(workdir, image) : null
}

/**
 * A short audio clip centred on `atSeconds`, so you can hear the name said
 * rather than trust the transcription of it. Returns null when the capture has
 * no usable audio — a carousel, or a reel using a licensed music track.
 */
export async function clipAt(captureId: string, atSeconds: number): Promise<string | null> {
  const workdir = await workdirFor(captureId)
  const stamp = atSeconds.toFixed(2).replace('.', '_')
  const dest = path.join(await evidenceDir(workdir), `clip-${stamp}.m4a`)
  if (await exists(dest)) return dest

  const audio = path.join(workdir, 'audio.flac')
  if (!(await exists(audio))) return null

  const start = Math.max(0, atSeconds - CLIP_PAD_SECONDS)
  await ffmpeg([
    '-ss', String(start),
    '-t', String(CLIP_PAD_SECONDS * 2),
    '-i', audio,
    '-c:a', 'aac', '-b:a', '96k',
    dest,
  ])
  return (await exists(dest)) ? dest : null
}
