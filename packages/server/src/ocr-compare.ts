/**
 * Run every configured OCR provider over the SAME frames and print what each
 * one actually read.
 *
 * On-screen text is a primary evidence source — for a music-track reel with a
 * thin caption it is the only source — so the question "can we rely on someone
 * other than Gemini?" deserves a measurement rather than a vendor claim. Travel
 * reels are the hard case: stylised type, motion blur, and non-Latin scripts.
 *
 *   npm run ocr:compare -w @reel/server -- "<url>"
 */
import { resolverFor } from './resolvers/index.ts'
import { captureIdFor, workdirFor } from './lib/workdir.ts'
import { extractFrames, type Frame } from './perception/media.ts'
import { PROVIDERS, activeProviders } from './perception/ocr/index.ts'
import type { OcrProvider } from './perception/ocr/types.ts'

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
}

const ts = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`

interface Reading {
  provider: string
  byFrame: Map<string, string>
  failed: number
  ms: number
  error?: string
}

async function readAll(provider: OcrProvider, frames: Frame[]): Promise<Reading> {
  const started = Date.now()
  const byFrame = new Map<string, string>()
  let failed = 0
  const size = Math.max(1, provider.framesPerRequest)

  for (let i = 0; i < frames.length; i += size) {
    const chunk = frames.slice(i, i + size)
    try {
      for (const read of await provider.readChunk(chunk)) {
        const frame = chunk[read.index]
        if (frame && read.text) byFrame.set(frame.file, read.text)
      }
    } catch (err) {
      failed += chunk.length
      if (failed === chunk.length) {
        return {
          provider: provider.name,
          byFrame,
          failed,
          ms: Date.now() - started,
          error: err instanceof Error ? err.message.slice(0, 160) : String(err),
        }
      }
    }
  }
  return { provider: provider.name, byFrame, failed, ms: Date.now() - started }
}

async function main() {
  const url = process.argv.slice(2).find((a) => !a.startsWith('--'))
  if (!url) {
    console.error(`usage: npm run ocr:compare -w @reel/server -- <url>

Runs every configured OCR provider over identical frames and prints a
frame-by-frame comparison. Providers whose keys are absent are skipped.`)
    process.exit(1)
  }

  const providers = activeProviders()
  const skipped = PROVIDERS.filter((p) => !p.configured).map((p) => p.name)

  if (providers.length < 2) {
    console.error(`${C.yellow('Only')} ${providers.length} provider configured${providers.length === 1 ? ` (${providers[0]!.name})` : ''}.`)
    if (skipped.length) {
      console.error(`Not configured: ${skipped.join(', ')}\n`)
      console.error(`To add Cloudflare Workers AI (no credit card, no phone verification,`)
      console.error(`10,000 neurons/day) put these in .env:`)
      console.error(`  CLOUDFLARE_ACCOUNT_ID=   ${C.dim('dash.cloudflare.com -> right sidebar')}`)
      console.error(`  CLOUDFLARE_API_TOKEN=    ${C.dim('My Profile -> API Tokens -> Workers AI template')}`)
    }
    if (providers.length === 0) process.exit(1)
    console.error(`\n${C.dim('Continuing with one provider — this shows what it reads, not a comparison.')}\n`)
  }

  const workdir = await workdirFor(captureIdFor(url))
  const resolver = resolverFor(url)
  console.error(C.dim(`resolving via ${resolver.name}...`))
  const media = await resolver.resolve(url, workdir)

  let frames: Frame[] = media.videoPath ? await extractFrames(media.videoPath, workdir) : []
  frames = [...frames, ...media.imagePaths.map((file) => ({ file, atSeconds: 0 }))]
  if (frames.length === 0) {
    console.error(C.red('No frames or images to read.'))
    process.exit(1)
  }

  console.error(C.dim(`${frames.length} frames; running ${providers.map((p) => p.name).join(', ')}...\n`))
  const readings: Reading[] = []
  for (const p of providers) readings.push(await readAll(p, frames))

  // --- per frame, side by side ---------------------------------------------
  for (const frame of frames) {
    const reads = readings.map((r) => ({ provider: r.provider, text: r.byFrame.get(frame.file) ?? '' }))
    if (reads.every((r) => !r.text)) continue

    console.log(C.bold(C.cyan(`── ${ts(frame.atSeconds)} ${'─'.repeat(50)}`)))
    for (const r of reads) {
      const label = r.provider.padEnd(11)
      console.log(r.text ? `  ${label} ${r.text.replace(/\n/g, ' / ')}` : `  ${label} ${C.dim('(nothing)')}`)
    }
    // Agreement is the useful signal: identical reads across independent
    // models is strong evidence the text really says that.
    const nonEmpty = reads.filter((r) => r.text).map((r) => r.text.replace(/\s+/g, ' ').trim())
    if (nonEmpty.length > 1) {
      const agree = new Set(nonEmpty.map((t) => t.toLowerCase())).size === 1
      console.log(`  ${agree ? C.green('agree') : C.yellow('DIFFER')}`)
    }
    console.log()
  }

  // --- summary --------------------------------------------------------------
  console.log(C.bold(C.cyan(`── SUMMARY ${'─'.repeat(50)}`)))
  for (const r of readings) {
    const line = `${r.provider.padEnd(11)} ${String(r.byFrame.size).padStart(2)}/${frames.length} frames with text  ${(r.ms / 1000).toFixed(1)}s`
    console.log(r.error ? `${line}  ${C.red('FAILED: ' + r.error)}` : line)
  }

  console.log(`\n${C.dim('Judge on the frames where they DIFFER, and on non-Latin script in particular —')}`)
  console.log(C.dim('small vision models are usually weakest exactly there, and travel reels are full of it.'))
}

main().catch((err: unknown) => {
  console.error(`\n${C.red('Failed:')} ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
