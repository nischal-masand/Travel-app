import { mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { env } from './env.ts'
import { mediaRef } from './urls.ts'

/**
 * Stable id per piece of MEDIA, not per URL string — so a reel shared twice
 * (each share carrying a different ?igsh= tracking param) is one capture, and
 * re-running it reuses the media already downloaded. Normalising here rather
 * than at each call site means no caller can forget to.
 */
export function captureIdFor(url: string): string {
  return createHash('sha1').update(mediaRef(url).key).digest('hex').slice(0, 12)
}

export async function workdirFor(captureId: string): Promise<string> {
  const dir = path.resolve(process.cwd(), env.workDir, captureId)
  await mkdir(path.join(dir, 'frames'), { recursive: true })
  return dir
}
