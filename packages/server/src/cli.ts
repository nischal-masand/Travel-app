import type { EvidenceBundle } from '@reel/shared'
import { buildEvidence } from './perception/bundle.ts'
import { extract } from './extract/index.ts'
import type { CaptureResult } from '@reel/shared'
import { biasEffect } from './perception/vocabulary.ts'
import { resolverFor } from './resolvers/index.ts'
import { captureIdFor, workdirFor } from './lib/workdir.ts'
import { probeDuration } from './perception/media.ts'
import { missingKeys } from './lib/env.ts'

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
}

function reportResult(r: CaptureResult) {
  heading(`PLACES  (${r.places.length})`)
  if (r.destination) console.log(C.dim(`destination: ${r.destination}
`))
  if (!r.places.length) console.log(C.dim('(none — nothing in this capture named a place)'))

  for (const p of r.places) {
    const badge = p.status === 'confirmed'
      ? C.green(`confirmed/${p.confidence}`)
      : C.yellow(`needs check/${p.confidence}`)
    console.log(`${C.bold(p.name)}  ${badge}  ${C.dim(p.kind)}`)
    if (p.canonicalName && p.canonicalName !== p.name) console.log(C.dim(`  google: ${p.canonicalName}`))
    if (p.address) console.log(C.dim(`  ${p.address}`))
    if (p.lat !== null) console.log(C.dim(`  ${p.lat.toFixed(5)}, ${p.lng!.toFixed(5)}`))

    // The audit trail: who said this, in what words, and when in the video.
    for (const m of p.mentions) {
      const at = m.sourceSeconds !== null ? C.yellow(ts(m.sourceSeconds)) : C.dim('  --  ')
      console.log(`  ${at} ${C.dim(m.sourceType.padEnd(12))} "${m.sourceQuote.slice(0, 80)}"`)
    }
    for (const t of p.tips) console.log(`    ${C.cyan(t.kind)}: ${t.text}`)
    for (const f of p.facts) console.log(`    ${C.cyan(f.label)}: ${f.value}`)
    console.log()
  }

  if (r.generalTips.length || r.generalFacts.length) {
    heading('NOT TIED TO ONE PLACE')
    for (const t of r.generalTips) console.log(`  ${C.cyan(t.kind)}: ${t.text}`)
    for (const f of r.generalFacts) console.log(`  ${C.cyan(f.label)}: ${f.value}`)
  }

  // The guard firing is the most important thing on screen when it happens.
  if (r.rejected.length) {
    heading(`DROPPED BY THE QUOTE CHECK  (${r.rejected.length})`)
    console.log(C.dim('The model produced these but could not back them with the evidence.'))
    for (const x of r.rejected) console.log(`  ${C.red('x')} ${x.reason}`)
  }
}

function keysNeededFor(url: string, resolveOnly: boolean): string[] {
  // --resolve-only stops before any model call, so it needs no AI keys. That
  // makes it the cheap way to debug a broken resolver without burning credits.
  const needed = resolveOnly ? [] : ['GEMINI_API_KEY', 'GROQ_API_KEY', 'GOOGLE_MAPS_API_KEY']
  if (/instagram\.com/i.test(url)) needed.push('APIFY_TOKEN')
  return needed
}

/** Stage A0 only: prove the fetch works before spending anything on models. */
async function resolveOnlyReport(url: string) {
  const workdir = await workdirFor(captureIdFor(url))
  const resolver = resolverFor(url)
  console.error(C.dim(`resolver: ${resolver.name}`))
  const m = await resolver.resolve(url, workdir)

  heading('RESOLVED')
  console.log(`platform:  ${m.platform}`)
  console.log(`author:    ${m.author ?? C.dim('unknown')}`)
  console.log(`posted:    ${m.postedAt ?? C.dim('unknown')}`)
  console.log(`video:     ${m.videoPath ?? C.dim('none (still or carousel post)')}`)
  if (m.videoPath) console.log(`duration:  ${(await probeDuration(m.videoPath))?.toFixed(2) ?? '?'}s`)
  console.log(`images:    ${m.imagePaths.length}`)
  console.log(`hashtags:  ${m.caption.hashtags.join(' ') || C.dim('none')}`)
  console.log(`location:  ${m.caption.locationTag ?? C.dim('none')}`)
  heading('CAPTION')
  console.log(m.caption.text.trim() || C.dim('(empty)'))
  console.log(`
${C.dim(`media in ${workdir}`)}`)
}

function heading(title: string) {
  console.log(`\n${C.bold(C.cyan(`── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`))}`)
}

const ts = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`

/**
 * Word-level diff between the cold and biased transcripts.
 *
 * This is the whole point of the Phase 1 gate: overall accuracy will look fine
 * while every place name is wrong, so what you need to see is precisely which
 * tokens the vocabulary biasing changed — and whether it changed them for the
 * better. Reading two full transcripts side by side will not show you that.
 */
function reportBiasEffect(bundle: EvidenceBundle) {
  const before = bundle.transcriptPass1
  const after = bundle.transcript
  if (!before || !after) return

  heading('ASR BIASING (pass 1 vs pass 2)')
  if (bundle.biasVerdict) console.log(C.bold(bundle.biasVerdict))
  console.log(C.dim(`vocabulary: ${after.vocabulary.join(', ') || '(none)'}\n`))

  const a = before.text.split(/\s+/)
  const b = after.text.split(/\s+/)
  const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

  let changes = 0
  let shown = 0
  for (let i = 0, j = 0; i < a.length || j < b.length; ) {
    const wa = a[i]
    const wb = b[j]
    if (wa !== undefined && wb !== undefined && norm(wa) === norm(wb)) { i++; j++; continue }
    // Re-sync on the next matching token so a single substitution doesn't
    // cascade into "everything after this differs".
    const resync = b.findIndex((w, k) => k >= j && wa !== undefined && norm(w) === norm(wa))
    if (wa !== undefined && resync > j) {
      changes++; j = resync; continue
    }
    if (wa !== undefined && wb !== undefined) {
      const proper = /^[\p{Lu}]/u.test(wa) || /^[\p{Lu}]/u.test(wb)
      if (proper && shown < 12) {
        console.log(`  ${C.red(wa)} ${C.dim('→')} ${C.green(wb)}`)
        shown++
      }
      changes++
    }
    i++; j++
  }
  if (changes === 0) console.log(C.dim('  (identical transcripts)'))
  else if (shown === 0) console.log(C.dim(`  (${changes} wording changes, none touching a proper noun)`))
  else if (changes > shown) console.log(C.dim(`  ...and ${changes - shown} more non-name changes`))
}

function report(bundle: EvidenceBundle) {
  heading('SOURCE')
  console.log(`${bundle.platform}  ${C.dim(bundle.url)}`)
  console.log(`author: ${bundle.author ?? C.dim('unknown')}   posted: ${bundle.postedAt ?? C.dim('unknown')}   duration: ${bundle.durationSeconds?.toFixed(1) ?? C.dim('n/a')}s`)

  heading('CAPTION  (spelling authority — corrects what ASR mangles)')
  console.log(bundle.caption.text.trim() || C.dim('(empty)'))
  if (bundle.caption.hashtags.length) console.log(C.dim(`\nhashtags: ${bundle.caption.hashtags.join(' ')}`))
  if (bundle.caption.locationTag) console.log(C.dim(`location tag: ${bundle.caption.locationTag}`))

  heading(`ON-SCREEN TEXT  (${bundle.onScreenText.length} regions via ${bundle.ocrProvider ?? 'none'})`)
  if (bundle.ocrFailedFrames > 0) {
    console.log(C.red(`! ${bundle.ocrFailedFrames} frames could not be read (provider unavailable).`))
    console.log(C.red('  This is a PARTIAL read — do not judge "no text on screen" from it.'))
  }
  if (!bundle.onScreenText.length) console.log(C.dim('(none found)'))
  for (const o of bundle.onScreenText) {
    console.log(`${C.yellow(ts(o.atSeconds))}  ${o.text.replace(/\n/g, ' / ')}`)
  }

  heading('TRANSCRIPT')
  if (bundle.skippedAsrReason) {
    console.log(C.yellow(`skipped: ${bundle.skippedAsrReason}`))
    console.log(C.dim('(deliberate: song lyrics in the evidence would let Stage B cite a lyric as a place.)'))
  } else if (!bundle.transcript) {
    console.log(C.dim('(no audio — carousel or still post. This is a normal capture.)'))
  } else {
    console.log(C.dim(`audio source: ${bundle.audioSource}`))
    console.log(C.dim(`pass ${bundle.transcript.pass}  ·  lang ${bundle.transcript.language ?? '?'}  ·  ${bundle.transcript.words.length} words`))
    console.log(bundle.transcript.text || C.dim('(empty)'))

    const shaky = bundle.transcript.words
      .filter((w) => w.confidence !== null && w.confidence < 0.75 && /^\p{Lu}/u.test(w.word.trim()))
    if (shaky.length) {
      console.log(C.dim('\nlow-confidence capitalised tokens (likely mangled place names):'))
      for (const w of shaky) {
        console.log(`  ${C.yellow(ts(w.startMs / 1000))}  ${C.red(w.word.trim())} ${C.dim(`(${w.confidence!.toFixed(2)})`)}`)
      }
    }
  }

  reportBiasEffect(bundle)

  heading('NEXT')
  console.log(`Read the above against the actual reel. You are checking three things:
  1. Are the ${C.bold('place names')} spelled right? Overall accuracy will look fine while
     every proper noun is wrong — that is the failure mode that matters.
  2. Did pass 2 ${C.bold('improve')} them, or just churn?
  3. Do the timestamps land within a second of the real moment?

Full bundle: ${C.dim(`.work/${bundle.captureId}/evidence.json`)}`)
}

async function main() {
  const args = process.argv.slice(2)
  const jsonOnly = args.includes('--json')
  const resolveOnly = args.includes('--resolve-only')
  const evidenceOnly = args.includes('--evidence-only')
  const url = args.find((a) => !a.startsWith('--'))

  if (!url) {
    console.error(`usage: npm run capture -- <url> [--json]

  <url>           an Instagram reel/post, YouTube video, YouTube Short, or TikTok
  --resolve-only  stop after fetching: no model calls, no credits spent
  --evidence-only stop after Stage A: no extraction, no geocoding
  --json          print the raw evidence bundle instead of the readable report`)
    process.exit(1)
  }

  const missing = missingKeys(keysNeededFor(url, resolveOnly))
  if (missing.length) {
    console.error(`${C.red('Missing API keys:')} ${missing.join(', ')}

Copy .env.example to .env and fill these in. All three have free tiers:
  GROQ_API_KEY    https://console.groq.com/keys          (2,000 transcriptions/day, no card)
  GEMINI_API_KEY  https://aistudio.google.com/apikey     (free tier, no billing account)
  APIFY_TOKEN     https://console.apify.com/settings/integrations  ($5/mo credits, no card)`)
    process.exit(1)
  }

  if (resolveOnly) return resolveOnlyReport(url)

  const started = Date.now()
  const bundle = await buildEvidence(url, (step, detail) => {
    process.stderr.write(`${C.dim(`[${((Date.now() - started) / 1000).toFixed(1)}s]`)} ${step}${detail ? ` ${C.dim(detail)}` : ''}\n`)
  })

  if (jsonOnly && evidenceOnly) { console.log(JSON.stringify(bundle, null, 2)); return }
  if (!jsonOnly) report(bundle)
  if (evidenceOnly) return

  const result = await extract(bundle, {
    onProgress: (step, detail) =>
      process.stderr.write(`${C.dim(`[${((Date.now() - started) / 1000).toFixed(1)}s]`)} ${step}${detail ? ` ${C.dim(detail)}` : ''}
`),
  })

  if (jsonOnly) console.log(JSON.stringify(result, null, 2))
  else reportResult(result)
}

/** Node wraps network failures as a bare "fetch failed"; the real reason sits
 *  in `cause`, sometimes nested. Unwrap it or you are debugging blind. */
function explain(err: unknown, depth = 0): string {
  if (!(err instanceof Error)) return String(err)
  const own = err.message
  const cause = (err as { cause?: unknown }).cause
  if (cause === undefined || depth > 4) return own
  const inner = explain(cause, depth + 1)
  return inner && inner !== own ? own + '\n  ' + C.dim('caused by:') + ' ' + inner : own
}

main().catch((err: unknown) => {
  console.error('\n' + C.red('Failed:') + ' ' + explain(err))
  if (process.env.DEBUG && err instanceof Error && err.stack) console.error(C.dim(err.stack))
  process.exit(1)
})
