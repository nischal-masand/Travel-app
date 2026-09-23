import { mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { env } from './env.ts'

/** Stable id per URL, so re-running a capture reuses its downloaded media. */
export function captureIdFor(url: string): string {
  return createHash('sha1').update(url.trim()).digest('hex').slice(0, 12)
}

export async function workdirFor(captureId: string): Promise<string> {
  const dir = path.resolve(process.cwd(), env.workDir, captureId)
  await mkdir(path.join(dir, 'frames'), { recursive: true })
  return dir
}
