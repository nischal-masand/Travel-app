import type { Caption, OnScreenText, Transcript } from '@reel/shared'

/**
 * Builds the proper-noun vocabulary that biases ASR pass 2.
 *
 * The written sources — caption, hashtags, Instagram's location tag, text
 * burned into frames — spell place names correctly by definition. The voiceover
 * does not. Handing these back to Whisper is what turns "noosa peneeda" into
 * "Nusa Penida", and a correctly spelled name is the only kind Google Places
 * will ever resolve.
 *
 * The QUALITY of this list matters more than it looks, which only becomes
 * obvious watching it fail: biasing on junk corrupts a transcript that was
 * already right. On a real capture a correct "Matching Planet" came back as
 * "Mac-shun Planet", because the vocabulary was mostly topic hashtags and
 * sentence-opening capitals. Everything below exists to keep those two
 * categories out.
 */

/**
 * Loose key: case, punctuation and spacing all ignored, so a hashtag like
 * "goldengai" still matches a transcript's "Golden Gai".
 */
export const key = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

const STOP = new Set([
  'the', 'this', 'that', 'these', 'those', 'a', 'an', 'and', 'but', 'or', 'if',
  'i', 'you', 'we', 'they', 'he', 'she', 'it', 'my', 'your', 'our', 'their',
  'in', 'on', 'at', 'to', 'for', 'of', 'from', 'with', 'by', 'is', 'are', 'was',
  'were', 'be', 'so', 'not', 'no', 'yes', 'here', 'there', 'when', 'where',
  'what', 'how', 'why', 'who', 'save', 'follow', 'comment', 'link', 'bio',
  'day', 'days', 'trip', 'travel', 'guide', 'tips', 'places', 'things', 'best',
  'every', 'just', 'would', 'could', 'should', 'first', 'last', 'now', 'then',
  'because', 'also', 'more', 'most', 'must', 'much', 'many', 'some',
])

interface Phrase {
  text: string
  atSentenceStart: boolean
}

/**
 * Runs of capitalised words — "Nusa Penida", "Mizutani Kamada", "Yuta San".
 *
 * Each run records whether it opened a sentence, because a SINGLE capitalised
 * word in that position ("Every tray feels...", "Just the thrill...") carries
 * no naming signal at all — grammar capitalised it, not meaning. A multi-word
 * run is kept wherever it sits, since "Yuta San makes places..." is still a name.
 */
function properNounPhrases(text: string): Phrase[] {
  const out: Phrase[] = []

  for (const line of text.split(/[\n.!?;:,()\[\]]+/)) {
    const tokens = line.trim().split(/\s+/).filter(Boolean)
    let run: string[] = []
    let runStartedAt = -1

    const flush = () => {
      if (run.length) out.push({ text: run.join(' '), atSentenceStart: runStartedAt === 0 })
      run = []
      runStartedAt = -1
    }

    for (const [i, token] of tokens.entries()) {
      const word = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
      const capped = /^\p{Lu}[\p{L}\p{N}’'-]*$/u.test(word) && !STOP.has(word.toLowerCase())
      if (capped) {
        if (!run.length) runStartedAt = i
        run.push(word)
      } else {
        flush()
      }
    }
    flush()
  }

  return out
}

/** #NusaPenida -> "Nusa Penida". An all-lowercase tag cannot be split. */
function splitHashtag(tag: string): { text: string; splittable: boolean } {
  const spaced = tag.replace(/[_-]+/g, ' ').replace(/(?<=\p{Ll})(?=\p{Lu})/gu, ' ').trim()
  return { text: spaced, splittable: spaced.includes(' ') }
}

export interface VocabSources {
  caption: Caption
  onScreenText: OnScreenText[]
  /** Optional extras, e.g. POI names from a Places lookup. */
  extra?: string[]
}

export interface Vocabulary {
  /**
   * Fed to Whisper. Deliberately conservative: a wrong term here actively
   * damages a transcript that was already correct.
   */
  bias: string[]
  /**
   * NOT fed to Whisper, but kept for Stage B cross-referencing. A tag like
   * #goldengai would only push Whisper toward writing it as one word, yet it is
   * strong corroboration that a transcript's "Golden Gai" names a real place.
   */
  corroboration: string[]
}

const MAX_TERMS = 40 // Groq caps `prompt` at 224 tokens.

export function buildVocabulary({ caption, onScreenText, extra = [] }: VocabSources): Vocabulary {
  const phrases = [
    ...properNounPhrases(caption.text),
    ...onScreenText.flatMap((o) => properNounPhrases(o.text)),
  ]
  const hashtags = caption.hashtags.map(splitHashtag)

  const biasCandidates = [
    // The location tag is the single most reliable term available.
    ...(caption.locationTag ? [caption.locationTag] : []),
    ...extra,
    ...phrases.filter((p) => p.text.includes(' ') || !p.atSentenceStart).map((p) => p.text),
    // Only hashtags that split into words: #NusaPenida yes, #japantravel no.
    ...hashtags.filter((h) => h.splittable).map((h) => h.text),
  ]

  return {
    bias: rank(biasCandidates),
    corroboration: rank(hashtags.filter((h) => !h.splittable).map((h) => h.text)),
  }
}

/** Longer phrases first: "Nusa Penida" biases far better than "Nusa". */
function rank(candidates: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []

  const sorted = candidates
    .map((c) => c.trim())
    .filter((c) => c.length >= 3 && c.length <= 48)
    .sort((a, b) => b.split(' ').length - a.split(' ').length || a.localeCompare(b))

  for (const term of sorted) {
    const k = key(term)
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(term)
    if (out.length >= MAX_TERMS) break
  }
  return out
}

/**
 * Decides whether to run the biased second pass, and says why.
 *
 * The obvious trigger — low per-word confidence on a capitalised token — does
 * NOT work. Whisper exposes no true per-word probability through the
 * OpenAI-shaped API, only `avg_logprob` per segment, and measured across real
 * reels that value is nearly constant (0.90-0.91 across an entire transcript).
 * It cannot tell a rare proper noun from the word "This", so a confidence
 * threshold either never fires or fires on everything.
 *
 * What does discriminate: a name the caption spells out that is ABSENT from the
 * transcript. Either it was never said, or ASR mangled it.
 */
export function secondPassReason(
  transcript: Transcript | null,
  vocabulary: string[],
): string | null {
  if (!transcript || vocabulary.length === 0) return null
  if (transcript.text.trim().length === 0) return null

  const haystack = key(transcript.text)
  const missing = vocabulary.filter((term) => {
    const k = key(term)
    return k.length >= 4 && !haystack.includes(k)
  })

  if (missing.length === 0) return null
  return `${missing.length} known name(s) missing: ${missing.slice(0, 4).join(', ')}`
}

export interface BiasEffect {
  gained: string[]
  lost: string[]
}

/** Which vocabulary terms each pass actually managed to produce. */
export function biasEffect(before: Transcript, after: Transcript, vocabulary: string[]): BiasEffect {
  const has = (t: Transcript, term: string) => key(t.text).includes(key(term))
  return {
    gained: vocabulary.filter((v) => !has(before, v) && has(after, v)),
    lost: vocabulary.filter((v) => has(before, v) && !has(after, v)),
  }
}

/**
 * Pass 2 is an experiment, not an upgrade — so check the result instead of
 * assuming it. Both transcripts are in hand, so the honest move is to keep
 * pass 2 only when it demonstrably won, and to say which one was kept.
 */
export function chooseTranscript(
  pass1: Transcript,
  pass2: Transcript,
  vocabulary: string[],
): { chosen: Transcript; effect: BiasEffect; verdict: string } {
  const effect = biasEffect(pass1, pass2, vocabulary)

  if (effect.lost.length > 0) {
    return { chosen: pass1, effect, verdict: `kept pass 1 — pass 2 lost: ${effect.lost.join(', ')}` }
  }
  if (effect.gained.length > 0) {
    return { chosen: pass2, effect, verdict: `kept pass 2 — recovered: ${effect.gained.join(', ')}` }
  }
  return { chosen: pass1, effect, verdict: 'kept pass 1 — pass 2 recovered no known name' }
}
