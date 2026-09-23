import { z } from 'zod'
import { SourceType } from './evidence.ts'

/**
 * STAGE B — INTERPRETATION, and STAGE C — VERIFICATION
 *
 * The core rule of this app lives here: the model may never *name* a place.
 * It may only point at text it was given. Every item carries `sourceQuote`,
 * a verbatim substring of the evidence bundle, and a code check (not a prompt
 * instruction) drops anything whose quote cannot be found. See verify.ts.
 */

export const PlaceKind = z.enum([
  'hotel', 'restaurant', 'cafe', 'bar', 'viewpoint', 'activity',
  'beach', 'museum', 'shop', 'transport', 'area', 'other',
])
export type PlaceKind = z.infer<typeof PlaceKind>

export const TipKind = z.enum(['do', 'dont', 'warning', 'hack', 'cost', 'logistics'])
export type TipKind = z.infer<typeof TipKind>

/**
 * One naming of a place by one source. Not yet merged with other sources —
 * "noosa peneeda" from the transcript and "Nusa Penida" from the caption are
 * two Mentions that B3 reconciliation will cluster into one Place.
 */
export const Mention = z.object({
  rawName: z.string().min(1),
  /** MUST appear verbatim in the evidence for this sourceType. Checked in code. */
  sourceQuote: z.string().min(1),
  sourceType: SourceType,
  /** Absent for caption-sourced mentions. Drives the frame + audio clip in the UI. */
  sourceSeconds: z.number().nonnegative().nullable().default(null),
  asrConfidence: z.number().min(0).max(1).nullable().default(null),
})
export type Mention = z.infer<typeof Mention>

/** A claim about a place or the trip. Conflicting facts are kept side by side. */
export const Fact = z.object({
  label: z.string().min(1),
  value: z.string().min(1),
  sourceQuote: z.string().min(1),
  sourceType: SourceType,
  sourceSeconds: z.number().nonnegative().nullable().default(null),
})
export type Fact = z.infer<typeof Fact>

export const Tip = z.object({
  kind: TipKind,
  text: z.string().min(1),
  sourceQuote: z.string().min(1),
  sourceType: SourceType,
  sourceSeconds: z.number().nonnegative().nullable().default(null),
  /** rawName of the place this applies to, if any. Resolved during reconcile. */
  aboutPlace: z.string().nullable().default(null),
})
export type Tip = z.infer<typeof Tip>

/**
 * What the interpretation model returns, per source. Deliberately flat and
 * quote-carrying — no merging, no canonical names, no confidence judgements.
 * Those are code's job, not the model's.
 */
export const ExtractionOutput = z.object({
  mentions: z.array(Mention).default([]),
  tips: z.array(Tip).default([]),
  facts: z.array(Fact).default([]),
  /** Free-text region/country if the source states one. Scopes geocoding. */
  destination: z.string().nullable().default(null),
})
export type ExtractionOutput = z.infer<typeof ExtractionOutput>

// ---------------------------------------------------------------------------
// STAGE C output
// ---------------------------------------------------------------------------

export const PlaceStatus = z.enum(['confirmed', 'needs_check'])
export type PlaceStatus = z.infer<typeof PlaceStatus>

export const Confidence = z.enum(['high', 'medium', 'low'])
export type Confidence = z.infer<typeof Confidence>

export const Place = z.object({
  id: z.string(),
  /** Canonical spelling. Precedence: caption > onScreenText > transcript. */
  name: z.string().min(1),
  kind: PlaceKind.default('other'),
  whyGo: z.string().nullable().default(null),
  timeNeeded: z.string().nullable().default(null),
  bestTime: z.string().nullable().default(null),

  /** Every source that named this place — the audit trail behind the pin. */
  mentions: z.array(Mention).min(1),
  /** Conflicts preserved, never silently resolved. */
  facts: z.array(Fact).default([]),
  tips: z.array(Tip).default([]),

  status: PlaceStatus,
  confidence: Confidence,
  /** Present iff status === 'confirmed'. */
  placeId: z.string().nullable().default(null),
  lat: z.number().nullable().default(null),
  lng: z.number().nullable().default(null),
  canonicalName: z.string().nullable().default(null),
  address: z.string().nullable().default(null),
})
export type Place = z.infer<typeof Place>

export const CaptureResult = z.object({
  captureId: z.string(),
  profile: z.enum(['travel', 'recipe', 'generic']),
  destination: z.string().nullable().default(null),
  places: z.array(Place).default([]),
  /** Tips not attached to any single place. */
  generalTips: z.array(Tip).default([]),
  /** Items the model produced whose quote failed the check. Kept for debugging. */
  rejected: z.array(z.object({ reason: z.string(), item: z.unknown() })).default([]),
})
export type CaptureResult = z.infer<typeof CaptureResult>
