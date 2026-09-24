import type { Confidence, PlaceKind, TipKind } from './extraction.ts'
import type { SourceType } from './evidence.ts'

/**
 * The HTTP contract between server and app — what actually travels as JSON.
 *
 * Defined here rather than inferred from the database rows so that both sides
 * are checked against one declaration: the server's store functions are typed
 * to return these, and the app imports them. A column rename then fails the
 * build in both places instead of surfacing as `undefined` on a phone.
 *
 * The app should import these as TYPES only (`import type`), so nothing in this
 * package — zod included — ends up in the mobile bundle.
 */

export type CaptureStatus = 'queued' | 'running' | 'done' | 'failed'

/**
 * `dismissed` exists only at this layer: the pipeline never produces it. It is
 * your verdict on a needs-check item, kept rather than deleted so the audit
 * trail survives and a re-run can't quietly resurrect something you rejected.
 */
export type ApiPlaceStatus = 'confirmed' | 'needs_check' | 'dismissed'

export interface ApiCapture {
  id: string
  url: string
  platform: string
  profile: string
  status: CaptureStatus
  /** Human-readable progress line while running, e.g. "ocr: 5 regions". */
  step: string | null
  /** The provider's own words on failure — "quota exhausted" and "post is
   *  private" need different responses, so this is never genericised. */
  error: string | null
  author: string | null
  postedAt: string | null
  caption: string | null
  durationSeconds: number | null
  destination: string | null
  /** Set when a reel used a licensed music track, so it has no transcript. */
  skippedAsrReason: string | null
  ocrFailedFrames: number
  /** Items the model produced but could not back with a quote. */
  rejectedCount: number
  createdAt: string
  completedAt: string | null
}

/** A capture as listed in the inbox, with enough counts to render a row. */
export interface ApiCaptureSummary extends ApiCapture {
  placeCount: number
  needsCheckCount: number
}

export interface ApiMention {
  id: number
  /** Our place id (the foreign key), not Google's. */
  placeId: string
  rawName: string
  sourceQuote: string
  sourceType: SourceType
  /** Where in the video — drives /frame and /clip. Null for caption mentions. */
  sourceSeconds: number | null
  asrConfidence: number | null
}

export interface ApiTip {
  id: number
  captureId: string
  placeId: string | null
  kind: TipKind
  text: string
  sourceQuote: string
  sourceType: SourceType
  sourceSeconds: number | null
}

export interface ApiFact {
  id: number
  captureId: string
  placeId: string | null
  label: string
  value: string
  sourceQuote: string
  sourceType: SourceType
  sourceSeconds: number | null
}

export interface ApiPlace {
  id: string
  captureId: string
  name: string
  kind: PlaceKind
  status: ApiPlaceStatus
  confidence: Confidence
  /** Google's place id. Present when confirmed, or when a loose candidate is
   *  offered for you to judge. */
  googlePlaceId: string | null
  lat: number | null
  lng: number | null
  canonicalName: string | null
  address: string | null
  /** Earliest moment in the video that named it. */
  firstSeconds: number | null
  /** 'user' once you have confirmed, corrected or dismissed it. */
  reviewedBy: 'user' | null
}

export interface ApiPlaceDetail extends ApiPlace {
  mentions: ApiMention[]
  tips: ApiTip[]
  facts: ApiFact[]
}

export interface ApiRejection {
  id: number
  captureId: string
  reason: string
  detail: string | null
}

export interface ApiCaptureDetail {
  capture: ApiCapture
  places: ApiPlaceDetail[]
  generalTips: ApiTip[]
  generalFacts: ApiFact[]
  rejected: ApiRejection[]
}

/** A needs-check item, carrying enough of its capture to say where it came from. */
export interface ApiTrayItem extends ApiPlace {
  mentions: ApiMention[]
  capture: Pick<ApiCapture, 'id' | 'url' | 'author' | 'platform'>
}

/** One pin per real place, however many reels mentioned it. */
export interface ApiMapPlace extends ApiPlace {
  captureIds: string[]
}

// --- request / response envelopes -----------------------------------------

export interface CreateCaptureRequest { url: string; profile?: 'travel' | 'recipe' | 'generic' }
export interface CreateCaptureResponse { id: string; status: CaptureStatus }
export interface CorrectPlaceRequest { name: string }
export interface ApiError { error: string; detail?: string }
