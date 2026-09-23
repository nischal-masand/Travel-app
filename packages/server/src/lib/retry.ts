/**
 * Free-tier model endpoints return 429 (rate limited) and 503 (overloaded)
 * routinely, and both clear on their own. A capture that dies on the first one
 * would make the pipeline feel broken when nothing is actually wrong.
 */

const RETRYABLE = [408, 409, 429, 500, 502, 503, 504]

/**
 * A 429 means two very different things.
 *
 * Per-minute rate limiting clears in seconds and is worth waiting out. A daily
 * QUOTA being exhausted does not clear for hours, and every retry spends more of
 * it — so retrying the same model makes things strictly worse.
 *
 * Measured against the live API: the free-tier daily quota is **per model**, not
 * per project. With gemini-3.5-flash exhausted, gemini-3.5-flash-lite and three
 * others still answered normally. So this is a hard stop for ONE model, and the
 * caller should move down its model chain rather than give up.
 */
export class QuotaExhaustedError extends Error {
  readonly model: string | undefined

  constructor(detail: string, model?: string) {
    super(
      `Daily quota exhausted for ${model ?? 'this model'}. ` +
      `Retrying it will not help — try another model, wait for the reset ` +
      `(midnight US Pacific), or enable billing. Provider said: ${detail.slice(0, 140)}`,
    )
    this.name = 'QuotaExhaustedError'
    this.model = model
  }
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  return typeof err === 'string' ? err : JSON.stringify(err ?? '')
}

export function isQuotaExhausted(err: unknown): boolean {
  const m = messageOf(err).toLowerCase()
  return /exceeded your current quota|resource_exhausted|quota_exceeded|billing details/.test(m)
}

function statusOf(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null
  const e = err as { status?: unknown; code?: unknown; message?: unknown }
  for (const v of [e.status, e.code]) {
    if (typeof v === 'number') return v
    if (typeof v === 'string' && /^\d{3}$/.test(v)) return Number(v)
  }
  // Google's SDK stringifies the whole error body into `message`.
  const m = typeof e.message === 'string' ? e.message.match(/"code"\s*:\s*(\d{3})/) : null
  return m ? Number(m[1]) : null
}

export function isRetryable(err: unknown): boolean {
  if (isQuotaExhausted(err)) return false
  const s = statusOf(err)
  if (s !== null) return RETRYABLE.includes(s)
  const msg = err instanceof Error ? err.message.toLowerCase() : ''
  return /overloaded|high demand|unavailable|rate limit|timeout|econnreset|etimedout|fetch failed/.test(msg)
}

export interface RetryOpts {
  attempts?: number
  baseMs?: number
  label?: string
  /** Named in the quota error so the caller knows which model to skip. */
  model?: string
  onRetry?: (attempt: number, waitMs: number, err: unknown) => void
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const { attempts = 4, baseMs = 2000, label = 'request', model, onRetry } = opts
  let last: unknown

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      last = err
      // Escalate immediately: this is not a wait-and-see condition.
      if (isQuotaExhausted(err)) throw new QuotaExhaustedError(messageOf(err), model ?? label)
      if (attempt === attempts || !isRetryable(err)) break
      // Exponential backoff with jitter, so parallel calls don't retry in lockstep.
      const wait = Math.round(baseMs * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5))
      onRetry?.(attempt, wait, err)
      await new Promise((r) => setTimeout(r, wait))
    }
  }

  const detail = last instanceof Error ? last.message : String(last)
  throw new Error(`${label} failed after ${attempts} attempts: ${detail}`)
}
