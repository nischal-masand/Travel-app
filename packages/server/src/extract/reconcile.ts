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

/** Do two names refer to one place? */
export function samePlace(a: string, b: string): boolean {
  const [ca, cb] = [compact(a), compact(b)]
  if (!ca || !cb) return false
  if (ca === cb) return true

  // Short codes collide easily ("Ebisu" and "Ubud" both shrink a long way), so
  // phonetic equality only counts once there is enough signal to be meaningful.
  const [pa, pb] = [phonetic(a), phonetic(b)]
  if (pa && pa === pb && pa.length >= 4) return true

  // A bare name and its fuller form are one place within a capture:
  // "Mandarake" and "Mandarake Shibuya", "Nusa Penida" and "Nusa Penida Bali".
  if (isTokenPrefix(a, b) || isTokenPrefix(b, a)) return true

  // Near-identical spelling catches what phonetics miss: accents, a dropped
  // article, a plural. Kept tight — this is a merge, and a wrong merge quietly
  // destroys a real place by folding it into another.
  return Math.min(ca.length, cb.length) >= 5 && similarity(ca, cb) >= 0.87
}

/**
 * Is `short` the leading part of `long`, token by token?
 *
 * Prefix specifically, not "contained anywhere": place names lead with the
 * distinctive word, so "Mandarake" belongs with "Mandarake Shibuya" while
 * "Beach" must NOT be swallowed by "Kelingking Beach" — that would fold every
 * beach in a capture into whichever one was named first.
 */
function isTokenPrefix(short: string, long: string): boolean {
  const st = tokens(short)
  const lt = tokens(long)
  if (st.length === 0 || st.length >= lt.length) return false
  if (compact(short).length < 4) return false
  return st.every((t, i) => t === lt[i])
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
    const rank = SOURCE_RANK[a.sourceType] - SOURCE_RANK[b.sourceType]
    if (rank !== 0) return rank
    return b.rawName.trim().length - a.rawName.trim().length
  })[0]!
  return best.rawName.trim()
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
