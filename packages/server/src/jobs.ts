import { buildEvidence } from './perception/bundle.ts'
import { extract } from './extract/index.ts'
import { markFailed, markRunning, saveResult } from './db/store.ts'

/**
 * An in-process queue, one capture at a time.
 *
 * Deliberately not pg-boss or Redis. The work is bounded by free-tier rate
 * limits, not by CPU — running three captures at once would just make three
 * providers throttle in parallel, and every extra moving part is one more thing
 * to install on a machine that does not have Docker. Serial is also what makes
 * the retry backoff meaningful.
 *
 * The job list lives in memory, so a crash mid-capture leaves that row 'running'
 * rather than losing it: re-sharing the link re-queues it, and the working
 * directory is already populated so the re-run is fast.
 */

interface Job {
  id: string
  url: string
  profile?: string
}

const pending: Job[] = []
let draining = false

export const queueDepth = () => pending.length + (draining ? 1 : 0)

export function enqueue(id: string, url: string, profile?: string): void {
  // Sharing the same reel twice while it is still queued should not run it twice.
  if (!pending.some((j) => j.id === id)) pending.push({ id, url, profile })
  void drain()
}

async function drain(): Promise<void> {
  if (draining) return
  draining = true
  try {
    let job: Job | undefined
    while ((job = pending.shift())) await run(job)
  } finally {
    draining = false
  }
}

async function run(job: Job): Promise<void> {
  const note = (step: string, detail?: string) => {
    const line = detail ? `${step}: ${detail}` : step
    console.log(`[${job.id}] ${line}`)
    void markRunning(job.id, line).catch(() => {})
  }

  try {
    const bundle = await buildEvidence(job.url, note)
    const result = await extract(bundle, {
      profile: (job.profile as 'travel' | 'recipe' | 'generic') ?? 'travel',
      onProgress: note,
    })
    await saveResult(bundle, result)
    console.log(`[${job.id}] done — ${result.places.length} place(s)`)
  } catch (err) {
    // The message is what the app shows, so keep the provider's own words:
    // "quota exhausted" and "post is private" need different responses from you,
    // and a generic "processing failed" hides which one happened.
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[${job.id}] failed — ${message}`)
    await markFailed(job.id, message).catch(() => {})
  }
}
