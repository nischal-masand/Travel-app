import { GoogleGenAI } from '@google/genai'
import { z } from 'zod'
import { ExtractionOutput, TipKind, evidenceTexts } from '@reel/shared'
import type {
  EvidenceBundle, Fact, Mention, OnScreenText, SourceType, Tip, TranscriptWord,
} from '@reel/shared'
import { QuotaExhaustedError, withRetry } from '../lib/retry.ts'
import { normalizeForMatch } from './verify.ts'

/**
 * STAGE B1 — INTERPRETATION
 *
 * The model reads the evidence and points at the parts of it that describe a
 * place, a tip or a fact. It is never asked to *know* anything: every item it
 * emits carries a `sourceQuote` that verify.ts (B2) checks against the real
 * evidence, and anything it cannot find is dropped. The prompt below makes
 * quoting the path of least resistance; the check is what makes it true.
 *
 * Two things are deliberately kept away from the model:
 *
 *  1. WHICH SOURCE an item came from. The model is run once per source and
 *     never sees more than one at a time, so `sourceType` is stamped here, in
 *     code, from the text we handed it. Given the whole bundle at once, a model
 *     will cheerfully read a name in the caption and file it under the
 *     transcript — and because the UI turns a transcript hit into a timestamped
 *     frame and audio clip, that one slip fabricates a MOMENT and shows it to
 *     the user as proof. Splitting the calls makes that structurally
 *     impossible rather than merely discouraged.
 *
 *  2. WHEN it was said. Timestamps are recovered below by finding the quote in
 *     `transcript.words`, which carry real ASR timings. A model asked for a
 *     timestamp returns a plausible number, and a plausible number is precisely
 *     the kind nobody can audit.
 */

export type Profile = 'travel' | 'recipe' | 'generic'
export type OnRetry = (attempt: number, waitMs: number, err: unknown) => void

export interface ModelRequest {
  system: string
  user: string
  /** Appears in retry and failure messages, so a bad call is traceable to a source. */
  label: string
}

/** The seam the tests inject at: below it is network, above it is logic. */
export type ModelCall = (req: ModelRequest, onRetry?: OnRetry) => Promise<string>

/** Caption first: it is the best-spelled source, so it wins ties on destination. */
const SOURCE_ORDER: SourceType[] = ['caption', 'onScreenText', 'transcript']

/**
 * A ceiling on how much text goes into one request. Truncating is safe in the
 * one way that matters here: the model can only quote what it was shown, and
 * what it was shown is a prefix of the real evidence, so every quote it returns
 * still verifies against the full bundle.
 */
const MAX_SOURCE_CHARS = 12_000

// ---------------------------------------------------------------------------
// What we accept back from the model
// ---------------------------------------------------------------------------

/**
 * Note what is NOT in these schemas: `sourceType`, `sourceSeconds`,
 * `asrConfidence`. Zod strips unknown keys, so when the model volunteers them
 * anyway — and it does — they are discarded at the door rather than trusted.
 */
const arrayOf = <T extends z.ZodTypeAny>(item: T) =>
  z.array(item).nullish().transform((v) => v ?? [])

const ReplyMention = z.object({
  rawName: z.string(),
  sourceQuote: z.string(),
})

const ReplyTip = z.object({
  // An out-of-vocabulary kind ("advice", "info") is a labelling slip, not a
  // fabrication — the quote is still the quote. Coerce, rather than throw away
  // a genuine checkable tip over a word that carries no evidence.
  kind: TipKind.catch('do'),
  text: z.string(),
  sourceQuote: z.string(),
  aboutPlace: z.string().nullish(),
})

const ReplyFact = z.object({
  label: z.string(),
  value: z.string(),
  sourceQuote: z.string(),
})

const ModelReply = z.object({
  mentions: arrayOf(ReplyMention),
  tips: arrayOf(ReplyTip),
  facts: arrayOf(ReplyFact),
  destination: z.string().nullish(),
})

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM = `You are reading ONE source of evidence taken from a short social video, and pointing at the parts of it that matter.

You may not name anything from your own knowledge. You may only point at text that is in front of you. Every item you return carries "sourceQuote": a span copied character-for-character out of the SOURCE TEXT. A separate program checks every quote against the original evidence and deletes whatever it cannot find, so an approximate, tidied or remembered quote is simply lost work.

Rules, and these are absolute:
- Copy quotes EXACTLY: same spelling, capitalisation, accents, script, punctuation. Never correct a typo, never translate, never expand an abbreviation, never stitch two separate passages into one quote.
- "rawName" must appear INSIDE its own "sourceQuote", spelled identically. If the text reads "noosa peneeda", rawName is "noosa peneeda" and NOT "Nusa Penida". A later stage matches a misspelling to its written form; correcting it here destroys that link.
- Keep each quote tight: the clause or sentence containing the thing, not a paragraph.
- Only emit a mention when the text actually names something specific and findable. "an amazing little cafe" names nothing, so skip it.
- Do not emit timestamps, source names, ids, categories or confidence scores. The program assigns those, and anything you send is discarded.
- Empty arrays are a correct and welcome answer. A guess is not.

Return a single JSON object and nothing else.`

const SOURCE_BRIEF: Record<SourceType, string> = {
  caption: "the caption the creator typed, followed by the hashtags and the post's own location tag. Spelling here is deliberate and correct, so preserve it.",
  transcript: "an automatic transcription of the speech. It is a machine's guess at sounds, so proper nouns are frequently misspelled and sentences run together. Quote the misspelling exactly as it appears.",
  onScreenText: 'text burned into the video frames: overlays, stickers, signage, menus, price boards. It may be fragmentary.',
}

const PROFILE_BRIEF: Record<Profile, string> = {
  travel: 'Places a viewer could actually go: hotels, restaurants, cafes, bars, beaches, viewpoints, museums, shops, activities, neighbourhoods, transport. Tips are advice about visiting, such as cost, timing, warnings or how to get there. Facts are stated claims about a place or the trip, such as a price, a duration or a best time.',
  recipe: 'Named dishes, ingredients, brands, and any shop or restaurant named. Tips are technique and warnings. Facts are quantities, times and temperatures.',
  generic: 'Any specific named thing a viewer could look up: a place, a venue, a product, a brand. Tips are advice stated in the text. Facts are claims stated in the text.',
}

const SHAPE = `{
  "mentions": [{ "rawName": "...", "sourceQuote": "..." }],
  "tips":     [{ "kind": "${TipKind.options.join('|')}", "text": "...", "sourceQuote": "...", "aboutPlace": "a rawName, or null" }],
  "facts":    [{ "label": "...", "value": "...", "sourceQuote": "..." }],
  "destination": "the region or country the text itself states, or null"
}`

export function buildPrompt(sourceType: SourceType, profile: Profile, text: string): ModelRequest {
  const body = text.length > MAX_SOURCE_CHARS ? text.slice(0, MAX_SOURCE_CHARS) : text
  return {
    label: `interpret ${sourceType}`,
    system: SYSTEM,
    user: [
      `LOOKING FOR: ${PROFILE_BRIEF[profile]}`,
      '',
      `THIS SOURCE IS: ${sourceType} — ${SOURCE_BRIEF[sourceType]}`,
      '',
      'Reply with JSON in exactly this shape:',
      SHAPE,
      '',
      '--- SOURCE TEXT (the only text you may quote) ---',
      body,
      '--- END SOURCE TEXT ---',
    ].join('\n'),
  }
}

// ---------------------------------------------------------------------------
// Timing: recovered from the evidence, never asked for
// ---------------------------------------------------------------------------

const tokensOf = (s: string) => normalizeForMatch(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean)

/** An ASR token can carry punctuation; flatten it to the same shape as a quote token. */
const wordToken = (w: TranscriptWord) => tokensOf(w.word).join('')

export interface Located {
  seconds: number | null
  /** The weakest ASR word in the matched span: the honest risk signal for a heard name. */
  confidence: number | null
}

interface Run { start: number; count: number }

/**
 * Longest contiguous run of `wanted` tokens inside `seq`, at ANY alignment —
 * the run may begin mid-quote. Requiring it to start at the quote's first word
 * made location brittle: ASR splitting "we're" into two tokens at the front of a
 * quote was enough to lose the timestamp entirely.
 */
function longestRun(seq: string[], wanted: string[], from = 0, to = seq.length): Run | null {
  let best: Run | null = null
  for (let i = from; i < to; i++) {
    for (let j = 0; j < wanted.length; j++) {
      let count = 0
      while (i + count < to && j + count < wanted.length && seq[i + count] === wanted[j + count]) count++
      if (count > (best?.count ?? 0)) best = { start: i, count }
    }
    if (best && best.count === wanted.length) break
  }
  return best
}

/** Exact, full occurrence of `wanted` within [from, to). */
function exactRun(seq: string[], wanted: string[], from = 0, to = seq.length): Run | null {
  if (wanted.length === 0) return null
  for (let i = from; i + wanted.length <= to; i++) {
    if (wanted.every((t, j) => seq[i + j] === t)) return { start: i, count: wanted.length }
  }
  return null
}

function located(words: TranscriptWord[], run: Run): Located {
  const span = words.slice(run.start, run.start + run.count)
  const scores = span.map((w) => w.confidence).filter((c): c is number => c !== null)
  return {
    seconds: span[0]!.startMs / 1000,
    confidence: scores.length > 0 ? Math.min(...scores) : null,
  }
}

/**
 * Find where a quote was spoken, by walking the ASR word list.
 *
 * `transcript.text` and `transcript.words` come out of the same response but are
 * not character-aligned, so a string offset into the text would not survive
 * punctuation. Token matching does. Used as-is for tips and facts, where the
 * whole statement is the evidence.
 */
export function locateInTranscript(words: TranscriptWord[], quote: string): Located {
  const miss: Located = { seconds: null, confidence: null }
  const wanted = tokensOf(quote)
  const usable = words.filter((w) => wordToken(w).length > 0)
  if (wanted.length === 0 || usable.length === 0) return miss

  const run = longestRun(usable.map(wordToken), wanted)
  // One matching token is only trustworthy when the quote IS one token. Below
  // that bar a stray "the" would happily place a quote anywhere in the video.
  if (!run || !(run.count === wanted.length || run.count >= 2)) return miss
  return located(usable, run)
}

/**
 * Find the moment a place's NAME was spoken — not where its quote begins.
 *
 * The difference is the whole point of the evidence clip. A real quote was
 * "Right here in the neighborhood we're in, Ebisu, is Janai Coffee": timed from
 * its first word, a three-second clip plays "Right here in the neighb—" and
 * stops before the name it was meant to prove. So the name is searched for
 * inside the quote's span first (the occurrence the model actually cited), then
 * anywhere in the transcript, and only failing both does it fall back to the
 * quote's start.
 *
 * Confidence is likewise the weakest word of the NAME: a shaky "the" nearby
 * says nothing about whether the place was heard correctly.
 */
export function locateMention(words: TranscriptWord[], quote: string, name: string): Located {
  const usable = words.filter((w) => wordToken(w).length > 0)
  if (usable.length === 0) return { seconds: null, confidence: null }
  const seq = usable.map(wordToken)
  const nameTokens = tokensOf(name)

  const quoteTokens = tokensOf(quote)
  const quoteRun = longestRun(seq, quoteTokens)
  const quoteOk = quoteRun && (quoteRun.count === quoteTokens.length || quoteRun.count >= 2)

  const inQuote = quoteOk
    ? exactRun(seq, nameTokens, quoteRun!.start, quoteRun!.start + quoteRun!.count)
    : null
  const anywhere = inQuote ?? exactRun(seq, nameTokens)
  if (anywhere) return located(usable, anywhere)

  return locateInTranscript(words, quote)
}

/**
 * On-screen text is already timestamped per frame, so the only question is which
 * frame the quote came off. `evidenceTexts` joins the frames with newlines,
 * which normalisation flattens: a quote spanning two frames verifies but belongs
 * to no single moment, and gets no timestamp rather than a wrong one.
 */
export function locateOnScreen(items: OnScreenText[], quote: string): number | null {
  const needle = normalizeForMatch(quote)
  if (needle.length === 0) return null
  const hit = items.find((item) => normalizeForMatch(item.text).includes(needle))
  return hit ? hit.atSeconds : null
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'

export interface InterpretProvider {
  readonly name: string
  /** False when its key is absent; the chain skips it silently. */
  readonly configured: boolean
  complete(req: ModelRequest, onRetry?: OnRetry): Promise<string>
}

export const groqInterpreter: InterpretProvider = {
  name: 'groq',
  get configured() {
    return Boolean(process.env.GROQ_API_KEY)
  },

  async complete(req: ModelRequest, onRetry?: OnRetry): Promise<string> {
    const model = process.env.GROQ_TEXT_MODEL || 'openai/gpt-oss-120b'

    const res = await withRetry(
      async () => {
        const r = await fetch(GROQ_URL, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${process.env.GROQ_API_KEY}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: req.system },
              { role: 'user', content: req.user },
            ],
          }),
          signal: AbortSignal.timeout(120_000),
        })
        if (!r.ok) {
          const body = await r.text().catch(() => '')
          // Carry the status so isRetryable/isQuotaExhausted can classify it.
          throw Object.assign(new Error(`Groq ${r.status}: ${body.slice(0, 200)}`), { status: r.status })
        }
        return r.json() as Promise<{ choices?: Array<{ message?: { content?: string } }> }>
      },
      { label: `${req.label} via groq (${model})`, model, attempts: 4, baseMs: 2000, onRetry },
    )

    return res.choices?.[0]?.message?.content ?? ''
  },
}

/**
 * Same shape as the OCR chain, and for the same reason: free-tier availability
 * swings hour to hour, and the daily quota is per model rather than per project.
 * An exhausted model is a reason to step sideways, not to abandon the capture.
 */
const GEMINI_CHAIN = [
  ...(process.env.GEMINI_TEXT_MODEL ? [process.env.GEMINI_TEXT_MODEL] : []),
  'gemini-3.5-flash',
  'gemini-3-flash-preview',
  'gemini-3.5-flash-lite',
  'gemini-flash-lite-latest',
].filter((m, i, all) => all.indexOf(m) === i)

export const geminiInterpreter: InterpretProvider = {
  name: 'gemini',
  get configured() {
    return Boolean(process.env.GEMINI_API_KEY)
  },

  async complete(req: ModelRequest, onRetry?: OnRetry): Promise<string> {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! })
    let lastErr: unknown

    for (const [i, model] of GEMINI_CHAIN.entries()) {
      try {
        const res = await withRetry(
          () => ai.models.generateContent({
            model,
            contents: [{ role: 'user', parts: [{ text: req.user }] }],
            config: {
              systemInstruction: req.system,
              responseMimeType: 'application/json',
              temperature: 0,
            },
          }),
          { label: `${req.label} via gemini (${model})`, model, attempts: 3, baseMs: 3000, onRetry },
        )
        return res.text ?? ''
      } catch (err) {
        lastErr = err
        const next = GEMINI_CHAIN[i + 1]
        if (!next) break
        const why = err instanceof QuotaExhaustedError ? 'out of daily quota' : 'unavailable'
        onRetry?.(0, 0, new Error(`${model} ${why} — trying ${next}`))
      }
    }

    throw new Error(
      `all gemini models failed (tried ${GEMINI_CHAIN.join(', ')}): ` +
      `${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    )
  },
}

/** Preference order. Groq leads: it is fast, free, and honours strict JSON mode. */
export const PROVIDERS: InterpretProvider[] = [groqInterpreter, geminiInterpreter]

export function activeInterpreters(): InterpretProvider[] {
  const only = process.env.INTERPRET_PROVIDER
  const configured = PROVIDERS.filter((p) => p.configured)
  return only ? configured.filter((p) => p.name === only) : configured
}

/** The real model call. Tests replace it wholesale — see `interpret`'s last argument. */
export const callModel: ModelCall = async (req, onRetry) => {
  const providers = activeInterpreters()
  if (providers.length === 0) {
    throw new Error(
      'No interpretation provider configured. Set GROQ_API_KEY (preferred) or GEMINI_API_KEY.',
    )
  }

  let lastErr: unknown
  for (const [i, provider] of providers.entries()) {
    try {
      return await provider.complete(req, onRetry)
    } catch (err) {
      lastErr = err
      const next = providers[i + 1]
      if (!next) break
      const why = err instanceof Error ? err.message.slice(0, 90) : String(err)
      onRetry?.(0, 0, new Error(`${provider.name} failed (${why}) — trying ${next.name}`))
    }
  }

  throw new Error(
    `interpretation failed on every provider (${providers.map((p) => p.name).join(', ')}): ` +
    `${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  )
}

// ---------------------------------------------------------------------------
// Interpretation
// ---------------------------------------------------------------------------

/**
 * An unusable reply is reported, never swallowed.
 *
 * Silently returning nothing here would look exactly like a reel that mentioned
 * no places: the pipeline would carry on and produce a confident, empty result
 * for a video full of restaurants. A broken provider has to be visibly broken.
 */
export class ModelReplyError extends Error {
  readonly sourceType: SourceType
  readonly raw: string

  constructor(sourceType: SourceType, detail: string, raw: string) {
    super(`interpretation of ${sourceType} returned an unusable reply: ${detail}\n${raw.slice(0, 400)}`)
    this.name = 'ModelReplyError'
    this.sourceType = sourceType
    this.raw = raw
  }
}

function parseReply(sourceType: SourceType, raw: string): z.infer<typeof ModelReply> {
  // Tolerate a fenced block: JSON mode usually prevents it, the fallback
  // provider is less disciplined about it, and a fence is a formatting quirk
  // rather than a failure of substance.
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim()
  if (cleaned.length === 0) throw new ModelReplyError(sourceType, 'empty reply', raw)

  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    throw new ModelReplyError(sourceType, 'not JSON', raw)
  }

  const result = ModelReply.safeParse(parsed)
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    throw new ModelReplyError(sourceType, detail, raw)
  }
  return result.data
}

/**
 * A destination has no quote field to check against, which makes it the one
 * field where a model could name somewhere it was never told about — and it
 * scopes geocoding, so a wrong one bends every lookup after it. Requiring it to
 * appear in the source text keeps it evidence-bound: "#balitravel" grounds
 * "Bali", while a confident "Indonesia" from a text that never says so is dropped.
 */
function groundedDestination(candidate: string | null | undefined, sourceText: string): string | null {
  const value = candidate?.trim()
  if (!value) return null
  return normalizeForMatch(sourceText).includes(normalizeForMatch(value)) ? value : null
}

/** Identical items from one source are one item; models repeat themselves across sentences. */
function dedupe<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const item of items) {
    const k = key(item)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(item)
  }
  return out
}

/**
 * One source, one call. Returns a valid `ExtractionOutput` in which every
 * `sourceType` was written by this function and every `sourceSeconds` was found
 * in the evidence.
 *
 * Nothing is verified here: B2 owns that, and it records WHY each rejected item
 * was rejected. Filtering early would throw that audit trail away. The only
 * items dropped here are ones with an empty name or quote, which carry no
 * evidence at all and so cannot even be described as rejected.
 */
export async function interpretSource(
  bundle: EvidenceBundle,
  profile: Profile,
  sourceType: SourceType,
  text: string,
  call: ModelCall,
  onRetry?: OnRetry,
): Promise<ExtractionOutput> {
  const reply = parseReply(sourceType, await call(buildPrompt(sourceType, profile, text), onRetry))

  const words = sourceType === 'transcript' ? bundle.transcript?.words ?? [] : []
  const locate = (quote: string, name?: string): Located => {
    if (sourceType === 'transcript') {
      // A mention is timed to its NAME, so the clip actually contains it; a tip
      // or fact is timed to its whole statement.
      return name ? locateMention(words, quote, name) : locateInTranscript(words, quote)
    }
    if (sourceType === 'onScreenText') {
      return { seconds: locateOnScreen(bundle.onScreenText, quote), confidence: null }
    }
    return { seconds: null, confidence: null }
  }

  const mentions: Mention[] = dedupe(
    reply.mentions
      .map((m) => ({ rawName: m.rawName.trim(), sourceQuote: m.sourceQuote.trim() }))
      .filter((m) => m.rawName.length > 0 && m.sourceQuote.length > 0)
      .map((m) => {
        const at = locate(m.sourceQuote, m.rawName)
        return {
          rawName: m.rawName,
          sourceQuote: m.sourceQuote,
          sourceType,
          sourceSeconds: at.seconds,
          asrConfidence: at.confidence,
        }
      }),
    (m) => `${normalizeForMatch(m.rawName)}|${normalizeForMatch(m.sourceQuote)}`,
  )

  const tips: Tip[] = dedupe(
    reply.tips
      .map((t) => ({ kind: t.kind, aboutPlace: t.aboutPlace, text: t.text.trim(), sourceQuote: t.sourceQuote.trim() }))
      .filter((t) => t.text.length > 0 && t.sourceQuote.length > 0)
      .map((t) => ({
        kind: t.kind,
        text: t.text,
        sourceQuote: t.sourceQuote,
        sourceType,
        sourceSeconds: locate(t.sourceQuote).seconds,
        aboutPlace: t.aboutPlace?.trim() || null,
      })),
    (t) => `${normalizeForMatch(t.text)}|${normalizeForMatch(t.sourceQuote)}`,
  )

  const facts: Fact[] = dedupe(
    reply.facts
      .map((f) => ({ label: f.label.trim(), value: f.value.trim(), sourceQuote: f.sourceQuote.trim() }))
      .filter((f) => f.label.length > 0 && f.value.length > 0 && f.sourceQuote.length > 0)
      .map((f) => ({
        label: f.label,
        value: f.value,
        sourceQuote: f.sourceQuote,
        sourceType,
        sourceSeconds: locate(f.sourceQuote).seconds,
      })),
    (f) => `${normalizeForMatch(f.label)}|${normalizeForMatch(f.value)}|${normalizeForMatch(f.sourceQuote)}`,
  )

  // Parsing our own construction is not ceremony: it is the last gate before
  // this leaves B1, and it fails here rather than three stages downstream.
  return ExtractionOutput.parse({
    mentions,
    tips,
    facts,
    destination: groundedDestination(reply.destination, text),
  })
}

/**
 * Run the model once per non-empty source and merge the results.
 *
 * Sequential rather than parallel: three requests are cheap, and free tiers rate
 * limit hard enough that firing them together turns one fast capture into three
 * backoffs.
 */
export async function interpret(
  bundle: EvidenceBundle,
  profile: Profile,
  onRetry?: OnRetry,
  call: ModelCall = callModel,
): Promise<ExtractionOutput> {
  const texts = evidenceTexts(bundle)
  const merged: ExtractionOutput = { mentions: [], tips: [], facts: [], destination: null }

  for (const sourceType of SOURCE_ORDER) {
    const text = texts[sourceType].trim()
    // An empty source is normal — a reel with no speech, a post with no overlay
    // — and not a failure. Calling the model with nothing to quote could only
    // invite an invention, so it is not called at all.
    if (text.length === 0) continue

    const out = await interpretSource(bundle, profile, sourceType, text, call, onRetry)
    merged.mentions.push(...out.mentions)
    merged.tips.push(...out.tips)
    merged.facts.push(...out.facts)
    // First non-null wins, and SOURCE_ORDER runs the best-spelled source first.
    merged.destination ??= out.destination
  }

  return ExtractionOutput.parse(merged)
}
