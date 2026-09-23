import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { ytdlp } from '../lib/exec.ts'
import { parseHashtags, type ResolvedMedia, type Resolver } from './types.ts'

/**
 * YouTube, Shorts and TikTok. None of these require a login, so yt-dlp handles
 * them for free — no third party, no credentials, no ban risk. Instagram is the
 * only platform that needs the paid resolver.
 */
export const ytdlpResolver: Resolver = {
  name: 'yt-dlp',

  matches(url) {
    return /(?:youtube\.com|youtu\.be|tiktok\.com)/i.test(url)
  },

  async resolve(url, workdir): Promise<ResolvedMedia> {
    const platform = /tiktok\.com/i.test(url) ? 'tiktok' : 'youtube'

    const raw = await ytdlp(['--dump-single-json', '--no-warnings', '--no-playlist', url])
    const meta = JSON.parse(raw) as {
      title?: string; description?: string; uploader?: string
      upload_date?: string; location?: string
    }

    // Cap at 720p: OCR needs to read overlay text, not appreciate the cinematography.
    await ytdlp([
      '--no-warnings', '--no-playlist',
      '-f', 'bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720][ext=mp4]/b',
      '--merge-output-format', 'mp4',
      '-o', path.join(workdir, 'video.%(ext)s'),
      url,
    ])

    const files = await readdir(workdir)
    const video = files.find((f) => /^video\.(mp4|mkv|webm|mov)$/i.test(f))
    if (!video) throw new Error(`yt-dlp produced no video file in ${workdir}`)

    const text = [meta.title, meta.description].filter(Boolean).join('\n\n')
    const d = meta.upload_date
    return {
      platform,
      url,
      author: meta.uploader ?? null,
      postedAt: d ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null,
      caption: { text, hashtags: parseHashtags(text), locationTag: meta.location ?? null },
      videoPath: path.join(workdir, video),
      separateAudioPath: null,
      usesOriginalAudio: null, // yt-dlp merges audio into the file; nothing to declare
      imagePaths: [],
    }
  },
}
