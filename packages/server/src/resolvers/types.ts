import type { Platform } from '@reel/shared'

export interface ResolvedMedia {
  platform: Platform
  url: string
  author: string | null
  postedAt: string | null
  caption: { text: string; hashtags: string[]; locationTag: string | null }
  /** Local path to the downloaded video, or null for a still/carousel post. */
  videoPath: string | null
  /**
   * Instagram serves DASH, so a reel's audio is often a SEPARATE stream and the
   * downloaded video has no audio track at all. When that happens this holds
   * the separately-downloaded audio.
   */
  separateAudioPath: string | null
  /**
   * False when the post uses a borrowed music track rather than the creator's
   * own audio. Transcribing a song would inject its lyrics into the evidence
   * bundle as if they were spoken claims — a direct route to invented places.
   * null when the platform doesn't say.
   */
  usesOriginalAudio: boolean | null
  /** Local paths to carousel slides / still images. */
  imagePaths: string[]
}

export interface Resolver {
  readonly name: string
  matches(url: string): boolean
  resolve(url: string, workdir: string): Promise<ResolvedMedia>
}

/** Captions carry hashtags inline; pull them out so they can bias ASR pass 2. */
export function parseHashtags(caption: string): string[] {
  return [...caption.matchAll(/#([\p{L}\p{N}_]+)/gu)].map((m) => m[1]!).filter(Boolean)
}
