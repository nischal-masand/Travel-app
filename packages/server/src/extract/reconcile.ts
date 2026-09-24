import { doubleMetaphone } from 'double-metaphone'
import type { Fact, Mention, SourceType, Tip } from '@reel/shared'
import { normalizeForMatch } from './verify.ts'

/**
 * STAGE B3 — cluster mentions of the same real place, then pick how to spell it.
 *
 * The caption, the on-screen text and the voiceover are three independent
 * witnesses, and they rarely agree on spelling. The written ones are right by
 * definition; ASR is guessing at sounds. So the job here is to recognise that
 * "noosa peneeda" and "Nusa Penida" are one place, and then keep the caption's
 * spelling — because Google Places will never resolve the other one, and a
 * place that cannot be geocoded cannot be verified or pinned.
 */

/** Written sources spell correctly; the transcript is a transcription of sound. */
const SOURCE_RANK: Record<SourceType, number> = {
  caption: 0,
  onScreenText: 1,
  transcript: 2,
}

const compact = (s: string) => normalizeForMatch(s).replace(/[^\p{L}\p{N}]/gu, '')

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u

/**
 * ASR errors are SOUND-alike errors, so phonetic codes are the right tool.
 * Plain string distance files "noosa peneeda" and "Nusa Penida" as different
 * places and puts two pins on the map for one beach.
 */
function phonetic(name: string): string {
  const [primary] = doubleMetaphone(compact(name))
  return primary
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length || !b.length) return Math.max(a.length, b.length)
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const curr = [i]
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j]! + 1,
        curr[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    prev = curr
  }
  return prev[b.length]!
}

const similarity = (a: string, b: string) =>
  a === b ? 1 : 1 - levenshtein(a, b) / Math.max(a.length, b.length)

/**
 * How strongly two names agree.
 *
 * Binary same/different is not enough once a geocoder is involved. Google
 * answers "ULTRAMAN STREET" for "Ultraman" and "Shinjuku Golden-Gai" for
 * "Golden Gai". The first is a different thing that merely starts the same way;
 * the second is plainly the same district. Grading the match lets a confident
 * one become a pin while a loose one goes to you to confirm.
 */
export type MatchStrength = 'exact' | 'strong' | 'prefix' | 'loose' | 'none'

export function matchStrength(a: string, b: string): MatchStrength {
  const [ca, cb] = [compact(a), compact(b)]
  if (!ca || !cb) return 'none'
  if (ca === cb) return 'exact'

  // Sound-alike: "noosa peneeda" and "Nusa Penida" share the code NSPNT. Short
  // codes collide easily, so this needs enough signal to mean anything.
  const [pa, pb] = [phonetic(a), phonetic(b)]
  if (pa && pa === pb && pa.length >= 4) return 'strong'

  // One name sitting whole inside the other as a contiguous run of tokens:
  // "Golden Gai" inside "Shinjuku Golden-Gai", "Mandarake" inside "Mandarake
  // Shibuya". Two or more tokens is distinctive enough to call it one place.
  // ONE token is not — that is how "Beach" gets swallowed by "Kelingking Beach"
  // and "Ultraman" by "ULTRAMAN STREET".
  // Japanese and Chinese are written without spaces, so "伊豆大島" is a single
  // "word" and token containment can never see "大島" inside it — the match
  // failed outright where the English equivalent ("Izu Oshima" / "Oshima")
  // came back as a suggestion. Character containment restores parity, with the
  // same grades: a shared leading run is 'prefix', anywhere else is 'loose'.
  // Never 'strong': a dropped or added qualifier is a real ambiguity (Japan has
  // many Ōshimas), so these reach the user as suggestions, not confirmations.
  if (CJK.test(ca) || CJK.test(cb)) {
    const [short, long] = ca.length <= cb.length ? [ca, cb] : [cb, ca]
    if (short.length >= 2 && short !== long) {
      if (long.startsWith(short)) return 'prefix'
      if (long.includes(short)) return 'loose'
    }
  }

  const contained = tokenContainment(a, b)
  if (contained === 'multi') return 'strong'
  // A single shared token is graded by WHERE it sits. Place names lead with the
  // distinctive word, so "Mandarake" opening "Mandarake Shibuya" is a real
  // relationship, while "Beach" merely ending "Kelingking Beach" is not.
  if (contained === 'prefix') return 'prefix'
  if (contained === 'single') return 'loose'

  // Near-identical spelling: accents, a dropped article, a plural.
  if (Math.min(ca.length, cb.length) >= 5 && similarity(ca, cb) >= 0.87) return 'strong'

  return 'none'
}

/**
 * Do two names refer to one place, confidently enough to MERGE them?
 *
 * Deliberately excludes 'loose'. Merging is destructive — folding "Beach" into
 * "Kelingking Beach" silently destroys a distinct place and there is no way to
 * notice afterwards. Geocoding is not destructive in the same way: it can take
 * a loose candidate and hand it to you to confirm, so it uses matchStrength
 * directly rather than this.
 */
export function samePlace(a: string, b: string): boolean {
  const strength = matchStrength(a, b)
  // 'prefix' counts here but NOT in geocoding, and the difference is the prior.
  // Two names from the SAME reel that share a leading word are almost certainly
  // one shop. A geocoder offering a longer name is just offering a guess, so
  // there the same shape has to be checked by a human.
  return strength === 'exact' || strength === 'strong' || strength === 'prefix'
}

/**
 * Is one name a contiguous run of tokens inside the other, and how distinctive
 * is the overlap? 'multi' for two or more shared tokens, 'single' for one.
 */
function tokenContainment(a: string, b: string): 'multi' | 'prefix' | 'single' | 'no' {
  const ta = tokens(a)
  const tb = tokens(b)
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta]
  if (short.length === 0 || short.length === long.length) return 'no'
  if (compact(short.join('')).length < 4) return 'no'

  for (let i = 0; i + short.length <= long.length; i++) {
    if (short.every((t, j) => t === long[i + j])) {
      if (short.length >= 2) return 'multi'
      return i === 0 ? 'prefix' : 'single'
    }
  }
  return 'no'
}

const tokens = (s: string) => normalizeForMatch(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean)

export interface Cluster {
  /** Canonical spelling: the best-ranked source's version of the name. */
  name: string
  mentions: Mention[]
  /** Distinct source types that named it — drives the confidence tier. */
  sources: SourceType[]
  /** Earliest moment in the video, for the frame + clip evidence in the UI. */
  firstSeconds: number | null
}

export function clusterMentions(mentions: Mention[]): Cluster[] {
  const groups: Mention[][] = []

  for (const mention of mentions) {
    const hit = groups.find((g) => g.some((m) => samePlace(m.rawName, mention.rawName)))
    if (hit) hit.push(mention)
    else groups.push([mention])
  }

  return groups.map((group) => ({
    name: canonicalName(group),
    mentions: group,
    sources: [...new Set(group.map((m) => m.sourceType))],
    firstSeconds: group
      .map((m) => m.sourceSeconds)
      .filter((s): s is number => s !== null)
      .sort((a, b) => a - b)[0] ?? null,
  }))
}

/**
 * Pick the spelling to geocode and show. Source rank decides it: a name that
 * was written down beats one that was heard. Within a rank, prefer the longer
 * form — "Mandarake Shibuya" says more than "Mandarake" and geocodes better.
 */
function canonicalName(group: Mention[]): string {
  const best = [...group].sort((a, b) => {
    const rank = effectiveRank(a) - effectiveRank(b)
    if (rank !== 0) return rank
    const form = wellFormedness(b.rawName) - wellFormedness(a.rawName)
    if (form !== 0) return form
    return b.rawName.trim().length - a.rawName.trim().length
  })[0]!
  return best.rawName.trim()
}

/**
 * Not every caption mention is prose.
 *
 * A hashtag arrives as one squashed lowercase run — "goldengai" — and on source
 * rank alone it outranks the voiceover's "Golden Gai". Observed on a live
 * capture: that handed the geocoder a string Google cannot resolve and turned a
 * real, confirmable bar district into an unverified pin.
 *
 * So a slug-shaped name is demoted BELOW every ordinary source rather than
 * merely tie-broken within its own. It is still evidence that the place was
 * mentioned — it just must not be the spelling anyone tries to look up.
 */
function effectiveRank(m: Mention): number {
  return SOURCE_RANK[m.sourceType] + (looksLikeSlug(m.rawName) ? 10 : 0)
}

const looksLikeSlug = (name: string) => {
  const n = name.trim()
  return n.length > 0 && !/\s/.test(n) && !/\p{Lu}/u.test(n)
}

/** Spaced and capitalised reads as a written name; squashed lowercase does not. */
function wellFormedness(name: string): number {
  const n = name.trim()
  return (/\s/.test(n) ? 2 : 0) + (/\p{Lu}/u.test(n) ? 1 : 0)
}

/**
 * Attach tips and facts to the place they are about.
 *
 * Conflicting facts are deliberately kept side by side rather than resolved.
 * If the caption says one price and the voiceover says another, showing both
 * with their sources is honest; silently picking one is how the app loses your
 * trust the first time you notice it guessed.
 */
export function attachToClusters<T extends { aboutPlace?: string | null }>(
  items: T[],
  clusters: Cluster[],
): { byCluster: Map<Cluster, T[]>; unattached: T[] } {
  const byCluster = new Map<Cluster, T[]>(clusters.map((c) => [c, []]))
  const unattached: T[] = []

  for (const item of items) {
    const about = item.aboutPlace?.trim()
    const cluster = about
      ? clusters.find((c) =>
          samePlace(c.name, about) || c.mentions.some((m) => samePlace(m.rawName, about)))
      : undefined

    if (cluster) byCluster.get(cluster)!.push(item)
    else unattached.push(item)
  }

  return { byCluster, unattached }
}

export type { Fact, Tip }
