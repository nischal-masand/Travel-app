import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { ffmpeg, ffprobe } from '../lib/exec.ts'

export async function probeDuration(file: string): Promise<number | null> {
  try {
    const out = await ffprobe(['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file])
    const n = Number.parseFloat(out.trim())
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

export async function hasAudioStream(file: string): Promise<boolean> {
  try {
    const out = await ffprobe(['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file])
    return out.trim().length > 0
  } catch {
    return false
  }
}

/**
 * 16 kHz mono FLAC — what Whisper actually consumes internally, and small
 * enough to stay well under Groq's upload limit. A 45s reel lands around 400 KB.
 */
export async function extractAudio(video: string, workdir: string): Promise<string> {
  const dest = path.join(workdir, 'audio.flac')
  await ffmpeg(['-i', video, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'flac', dest])
  return dest
}

export interface Frame { file: string; atSeconds: number }

const SCENE_THRESHOLD = 0.3
const MIN_FRAMES = 4
const MAX_FRAMES = 10

/**
 * Cut frames on scene change rather than at a fixed interval: overlay text
 * persists for seconds, so uniform sampling reads the same words ten times and
 * still misses the one-second title card.
 *
 * Talking-head reels have almost no scene changes while the text overlay swaps
 * repeatedly, so a too-thin result falls back to interval sampling.
 */
export async function extractFrames(video: string, workdir: string): Promise<Frame[]> {
  const dir = path.join(workdir, 'frames')

  // `file=-` writes the metadata to stdout, which sidesteps having to escape a
  // Windows drive-letter path inside ffmpeg's colon-delimited filter syntax.
  const stdout = await ffmpeg([
    '-i', video,
    // Downscaled to 640px on the long edge: overlay text stays perfectly
    // legible, while the upload and the token count drop by roughly 10x —
    // which matters a lot when the free tier is queueing requests by size.
    '-vf', `select='gt(scene,${SCENE_THRESHOLD})',scale='min(640,iw)':-2,metadata=print:file=-`,
    '-vsync', 'vfr', '-q:v', '3',
    // Real-world video is usually limited-range YUV, which ffmpeg's mjpeg
    // encoder refuses outright ("Non full-range YUV is non-standard"). Forcing
    // the full-range JPEG pixel format converts instead of failing.
    '-pix_fmt', 'yuvj420p',
    path.join(dir, 'scene-%03d.jpg'),
  ])

  let frames = await collect(dir, 'scene-', parseTimes(stdout))

  if (frames.length < MIN_FRAMES) {
    const duration = (await probeDuration(video)) ?? 0
    const every = duration > 0 && duration / 1.5 > MAX_FRAMES ? duration / MAX_FRAMES : 1.5
    await ffmpeg([
      '-i', video,
      '-vf', `fps=1/${every.toFixed(3)},scale='min(640,iw)':-2`,
      '-q:v', '3', '-pix_fmt', 'yuvj420p',
      path.join(dir, 'tick-%03d.jpg'),
    ])
    const ticks = await collect(dir, 'tick-', [])
    frames = ticks.map((f, i) => ({ ...f, atSeconds: +(i * every).toFixed(2) }))
  }

  return downsample(frames, MAX_FRAMES)
}

function parseTimes(stdout: string): number[] {
  return [...stdout.matchAll(/pts_time:([0-9.]+)/g)].map((m) => Number.parseFloat(m[1]!))
}

async function collect(dir: string, prefix: string, times: number[]): Promise<Frame[]> {
  const files = (await readdir(dir)).filter((f) => f.startsWith(prefix)).sort()
  const out: Frame[] = []
  for (const [i, f] of files.entries()) {
    const full = path.join(dir, f)
    if ((await stat(full)).size === 0) continue
    out.push({ file: full, atSeconds: times[i] ?? 0 })
  }
  return out
}

/** Keep the ends, thin the middle evenly. */
function downsample(frames: Frame[], max: number): Frame[] {
  if (frames.length <= max) return frames
  const step = frames.length / max
  return Array.from({ length: max }, (_, i) => frames[Math.floor(i * step)]!)
}
