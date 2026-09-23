import type { EvidenceBundle, Mention, SourceType } from '@reel/shared'
import { evidenceTexts } from '@reel/shared'

/**
 * STAGE B2 — the guard the whole product rests on.
 *
 * The interpretation model is required to quote the evidence for every item it
 * emits. This file checks that the quote is really there, in the source the
 * model claimed it came from. Anything that fails is dropped before it can
 * reach the database.
 *
 * This is deliberately CODE rather than a stern instruction in the prompt. A
 * prompt asking a model not to invent things is a request; a substring check is
 * a guarantee. A fabricated café is worse than no app at all, because you only
 * discover it standing on the street looking for it.
 */

/**
 * Normalisation is the one place this could go wrong in either direction: too
 * strict and honest quotes get thrown away over a curly apostrophe; too loose
 * and the check stops meaning anything.
 *
 * So it only ever removes FORMATTING — unicode composition, quote and dash
 * styling, whitespace runs, invisible characters. It never removes or
 * substitutes letters, and it never does fuzzy matching. The words themselves
 * must be present.
 */
export function normalizeForMatch(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[​-‍﻿⁠]/g, '')       // zero-width / invisible
    .replace(/[‘’‚‛′]/g, "'") // curly single quotes
    .replace(/[“”„‟″]/g, '"') // curly double quotes
    .replace(/[‐-―−]/g, '-')            // dash variants
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

export interface Rejection {
  reason: string
  sourceType: SourceType
  quote: string
  item: unknown
}

export interface VerifyResult<T> {
  kept: T[]
  rejected: Rejection[]
}

export interface Quoting {
  sourceQuote: string
  sourceType: SourceType
}

/**
 * Keeps only items whose `sourceQuote` genuinely appears in the evidence for
 * the source they named.
 *
 * Checking against the CLAIMED source specifically, rather than the bundle as a
 * whole, matters more than it looks: it stops the model reading a name in the
 * caption and then attributing it to the transcript with a timestamp, which
 * would put a fabricated moment in front of you as if it were proof.
 */
export function verifyQuotes<T extends Quoting>(
  items: T[],
  bundle: EvidenceBundle,
): VerifyResult<T> {
  const sources = evidenceTexts(bundle)
  const normalized: Record<SourceType, string> = {
    caption: normalizeForMatch(sources.caption),
    transcript: normalizeForMatch(sources.transcript),
    onScreenText: normalizeForMatch(sources.onScreenText),
  }

  const kept: T[] = []
  const rejected: Rejection[] = []

  for (const item of items) {
    const quote = (item.sourceQuote ?? '').trim()
    const haystack = normalized[item.sourceType]

    if (quote.length < 2) {
      rejected.push({ reason: 'empty or trivial quote', sourceType: item.sourceType, quote, item })
      continue
    }
    if (haystack === undefined || haystack.length === 0) {
      rejected.push({
        reason: `claimed source "${item.sourceType}" is empty in this capture`,
        sourceType: item.sourceType, quote, item,
      })
      continue
    }
    if (!haystack.includes(normalizeForMatch(quote))) {
      rejected.push({
        reason: `quote not found in ${item.sourceType}`,
        sourceType: item.sourceType, quote, item,
      })
      continue
    }
    kept.push(item)
  }

  return { kept, rejected }
}

/**
 * A verified quote proves the words exist. It does not prove the NAME does —
 * a model can quote an honest sentence and still pull a place out of thin air
 * that the sentence never mentions. So the name has to appear inside its own
 * quote too.
 */
export function verifyMentions(
  mentions: Mention[],
  bundle: EvidenceBundle,
): VerifyResult<Mention> {
  const { kept, rejected } = verifyQuotes(mentions, bundle)
  const confirmed: Mention[] = []

  for (const mention of kept) {
    const name = normalizeForMatch(mention.rawName)
    if (name.length < 2) {
      rejected.push({ reason: 'empty name', sourceType: mention.sourceType, quote: mention.sourceQuote, item: mention })
      continue
    }
    if (!normalizeForMatch(mention.sourceQuote).includes(name)) {
      rejected.push({
        reason: `name "${mention.rawName}" does not appear in its own quote`,
        sourceType: mention.sourceType, quote: mention.sourceQuote, item: mention,
      })
      continue
    }
    confirmed.push(mention)
  }

  return { kept: confirmed, rejected }
}
