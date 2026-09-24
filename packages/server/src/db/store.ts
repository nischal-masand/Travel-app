import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import type {
  ApiCapture, ApiCaptureDetail, ApiCaptureSummary, ApiFact, ApiMapPlace, ApiMention,
  ApiPlace, ApiPlaceDetail, ApiRejection, ApiTip, ApiTrayItem, CaptureResult, EvidenceBundle,
  PlaceKind,
} from '@reel/shared'
import { db, captures, facts, mentions, places, rejections, tips } from './index.ts'

/**
 * Persisting a capture writes the evidence alongside the conclusion — every
 * mention with its source and its second. Without that the app can show a pin
 * but not why it believes in it, and "why do you believe this" is the entire
 * product.
 *
 * Every read returns a type from @reel/shared's API contract, so the app and the
 * server are checked against one declaration. The casts below are the single
 * place where a DB string becomes a typed union; the DB only ever holds values
 * this file wrote.
 */

type CaptureRow = typeof captures.$inferSelect
type PlaceRow = typeof places.$inferSelect
type MentionRow = typeof mentions.$inferSelect
type TipRow = typeof tips.$inferSelect
type FactRow = typeof facts.$inferSelect

const toCapture = (r: CaptureRow): ApiCapture => ({ ...r, status: r.status as ApiCapture['status'] })

const toPlace = (r: PlaceRow): ApiPlace => ({
  ...r,
  kind: r.kind as PlaceKind,
  status: r.status as ApiPlace['status'],
  confidence: r.confidence as ApiPlace['confidence'],
  reviewedBy: r.reviewedBy === 'user' ? 'user' : null,
})

const toMention = (r: MentionRow): ApiMention => ({ ...r, sourceType: r.sourceType as ApiMention['sourceType'] })
const toTip = (r: TipRow): ApiTip => ({
  ...r, kind: r.kind as ApiTip['kind'], sourceType: r.sourceType as ApiTip['sourceType'],
})
const toFact = (r: FactRow): ApiFact => ({ ...r, sourceType: r.sourceType as ApiFact['sourceType'] })

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createCapture(input: {
  id: string
  url: string
  platform?: string
  profile?: string
}): Promise<void> {
  await db.insert(captures).values({
    id: input.id,
    url: input.url,
    platform: input.platform ?? 'unknown',
    profile: input.profile ?? 'travel',
    status: 'queued',
  }).onConflictDoUpdate({
    target: captures.id,
    // Re-sharing a link re-runs it rather than erroring: the reel may have been
    // captured before a pipeline fix, and the user's intent is plainly "do it".
    set: { status: 'queued', step: null, error: null, completedAt: null },
  })
}

export async function markRunning(id: string, step: string): Promise<void> {
  await db.update(captures).set({ status: 'running', step }).where(eq(captures.id, id))
}

export async function markFailed(id: string, error: string): Promise<void> {
  await db.update(captures)
    .set({ status: 'failed', error: error.slice(0, 2000), completedAt: new Date().toISOString() })
    .where(eq(captures.id, id))
}

/**
 * Replaces any previous result for this capture, so a re-run is clean — with
 * one exception: places you have already reviewed keep your verdict. Re-running
 * a reel after a pipeline fix must not resurrect something you dismissed or
 * demote something you confirmed.
 */
export async function saveResult(
  bundle: EvidenceBundle,
  result: CaptureResult,
): Promise<void> {
  const id = bundle.captureId

  const reviewed = new Map(
    (await db.select().from(places).where(and(eq(places.captureId, id), eq(places.reviewedBy, 'user'))))
      .map((p) => [p.id, p]),
  )

  // Children are cleared explicitly rather than left to ON DELETE CASCADE.
  // Whether SQLite enforces foreign keys depends on a per-connection pragma the
  // driver may or may not set (libSQL here does; a Postgres swap would), and
  // correctness should not hinge on which.
  await db.delete(mentions).where(sql`place_id IN (SELECT id FROM places WHERE capture_id = ${id})`)
  await db.delete(tips).where(eq(tips.captureId, id))
  await db.delete(facts).where(eq(facts.captureId, id))
  await db.delete(rejections).where(eq(rejections.captureId, id))
  await db.delete(places).where(eq(places.captureId, id))

  // Upsert rather than update: places reference this row, and foreign keys ARE
  // enforced, so a result saved without a prior createCapture (the CLI path, or
  // a DB rebuilt from .work) must create its parent rather than fail on it.
  const summary = {
    status: 'done',
    step: null,
    error: null,
    platform: bundle.platform,
    author: bundle.author,
    postedAt: bundle.postedAt,
    caption: bundle.caption.text,
    durationSeconds: bundle.durationSeconds,
    destination: result.destination,
    skippedAsrReason: bundle.skippedAsrReason,
    // A transcript exists exactly when there is spoken audio to clip. A music
    // track is skipped before transcription, so it correctly reads false.
    hasAudio: bundle.transcript !== null && bundle.transcript.text.trim().length > 0,
    ocrFailedFrames: bundle.ocrFailedFrames,
    rejectedCount: result.rejected.length,
    completedAt: new Date().toISOString(),
  }
  await db.insert(captures)
    .values({ id, url: bundle.url, profile: result.profile, ...summary })
    .onConflictDoUpdate({ target: captures.id, set: summary })

  for (const place of result.places) {
    const prior = reviewed.get(place.id)
    await db.insert(places).values({
      id: place.id,
      captureId: id,
      name: prior?.name ?? place.name,
      kind: prior?.kind ?? place.kind,
      status: prior?.status ?? place.status,
      confidence: prior?.confidence ?? place.confidence,
      googlePlaceId: prior?.googlePlaceId ?? place.placeId,
      lat: prior?.lat ?? place.lat,
      lng: prior?.lng ?? place.lng,
      canonicalName: prior?.canonicalName ?? place.canonicalName,
      address: prior?.address ?? place.address,
      firstSeconds: place.mentions
        .map((m) => m.sourceSeconds)
        .filter((s): s is number => s !== null)
        .sort((a, b) => a - b)[0] ?? null,
      reviewedBy: prior ? 'user' : null,
    })

    for (const m of place.mentions) {
      await db.insert(mentions).values({
        placeId: place.id,
        rawName: m.rawName,
        sourceQuote: m.sourceQuote,
        sourceType: m.sourceType,
        sourceSeconds: m.sourceSeconds,
        asrConfidence: m.asrConfidence,
      })
    }
    for (const t of place.tips) await db.insert(tips).values({ captureId: id, placeId: place.id, ...tipFields(t) })
    for (const f of place.facts) await db.insert(facts).values({ captureId: id, placeId: place.id, ...factFields(f) })
  }

  for (const t of result.generalTips) await db.insert(tips).values({ captureId: id, placeId: null, ...tipFields(t) })
  for (const f of result.generalFacts) await db.insert(facts).values({ captureId: id, placeId: null, ...factFields(f) })
  for (const r of result.rejected) await db.insert(rejections).values({ captureId: id, reason: r.reason, detail: null })
}

const tipFields = (t: CaptureResult['generalTips'][number]) => ({
  kind: t.kind, text: t.text, sourceQuote: t.sourceQuote,
  sourceType: t.sourceType, sourceSeconds: t.sourceSeconds,
})

const factFields = (f: CaptureResult['generalFacts'][number]) => ({
  label: f.label, value: f.value, sourceQuote: f.sourceQuote,
  sourceType: f.sourceType, sourceSeconds: f.sourceSeconds,
})

export async function deleteCapture(id: string): Promise<boolean> {
  const [found] = await db.select({ id: captures.id }).from(captures).where(eq(captures.id, id))
  if (!found) return false
  await db.delete(mentions).where(sql`place_id IN (SELECT id FROM places WHERE capture_id = ${id})`)
  await db.delete(tips).where(eq(tips.captureId, id))
  await db.delete(facts).where(eq(facts.captureId, id))
  await db.delete(rejections).where(eq(rejections.captureId, id))
  await db.delete(places).where(eq(places.captureId, id))
  await db.delete(captures).where(eq(captures.id, id))
  return true
}

// --- your verdicts on the tray ---------------------------------------------

export async function getPlace(id: string): Promise<(ApiPlace & { destination: string | null }) | null> {
  const [row] = await db.select().from(places).where(eq(places.id, id))
  if (!row) return null
  const [cap] = await db.select({ destination: captures.destination }).from(captures)
    .where(eq(captures.id, row.captureId))
  return { ...toPlace(row), destination: cap?.destination ?? null }
}

/**
 * You vouch for it. Confidence becomes 'high' because a human looked at the
 * evidence — that is a stronger check than any match grade. A place confirmed
 * without coordinates stays off the map; it is real, just not pinned.
 */
export async function confirmPlace(id: string): Promise<ApiPlace | null> {
  await db.update(places)
    .set({ status: 'confirmed', confidence: 'high', reviewedBy: 'user' })
    .where(eq(places.id, id))
  return (await getPlace(id)) ?? null
}

/** Kept, not deleted: the audit trail survives, and a re-run cannot revive it. */
export async function dismissPlace(id: string): Promise<ApiPlace | null> {
  await db.update(places).set({ status: 'dismissed', reviewedBy: 'user' }).where(eq(places.id, id))
  return (await getPlace(id)) ?? null
}

/**
 * You typed the right name and Google resolved it. The mentions are untouched:
 * your correction is not evidence from the reel, so it must not be recorded as
 * if the creator had said it.
 */
export async function applyCorrection(id: string, fix: {
  name: string
  kind: PlaceKind
  status: 'confirmed' | 'needs_check'
  confidence: ApiPlace['confidence']
  googlePlaceId: string | null
  lat: number | null
  lng: number | null
  canonicalName: string | null
  address: string | null
}): Promise<ApiPlace | null> {
  await db.update(places).set({ ...fix, reviewedBy: 'user' }).where(eq(places.id, id))
  return (await getPlace(id)) ?? null
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listCaptures(limit = 50): Promise<ApiCaptureSummary[]> {
  // The outer table is named in full, deliberately. Interpolating captures.id
  // makes Drizzle emit a bare "id", which inside this subquery SQLite resolves
  // to places.id — so every capture silently counted zero places.
  const rows = await db.select({
    capture: captures,
    placeCount: sql<number>`(SELECT COUNT(*) FROM places p WHERE p.capture_id = "captures"."id" AND p.status != 'dismissed')`,
    needsCheckCount: sql<number>`(SELECT COUNT(*) FROM places p WHERE p.capture_id = "captures"."id" AND p.status = 'needs_check')`,
  }).from(captures).orderBy(desc(captures.createdAt)).limit(limit)

  return rows.map((r) => ({
    ...toCapture(r.capture),
    placeCount: Number(r.placeCount),
    needsCheckCount: Number(r.needsCheckCount),
  }))
}

export async function getCapture(id: string): Promise<ApiCaptureDetail | null> {
  const [capture] = await db.select().from(captures).where(eq(captures.id, id))
  if (!capture) return null

  const rows = await db.select().from(places).where(eq(places.captureId, id))
  const detailed: ApiPlaceDetail[] = await Promise.all(rows.map(async (p) => ({
    ...toPlace(p),
    mentions: (await db.select().from(mentions).where(eq(mentions.placeId, p.id))).map(toMention),
    tips: (await db.select().from(tips).where(eq(tips.placeId, p.id))).map(toTip),
    facts: (await db.select().from(facts).where(eq(facts.placeId, p.id))).map(toFact),
  })))

  const rejected: ApiRejection[] = await db.select().from(rejections).where(eq(rejections.captureId, id))

  return {
    capture: toCapture(capture),
    places: detailed,
    generalTips: (await db.select().from(tips).where(and(eq(tips.captureId, id), sql`place_id IS NULL`))).map(toTip),
    generalFacts: (await db.select().from(facts).where(and(eq(facts.captureId, id), sql`place_id IS NULL`))).map(toFact),
    rejected,
  }
}

/** Everything awaiting your judgement, newest capture first. The tray. */
export async function listNeedsCheck(limit = 100): Promise<ApiTrayItem[]> {
  const rows = await db.select({ place: places, capture: captures })
    .from(places)
    .innerJoin(captures, eq(places.captureId, captures.id))
    .where(eq(places.status, 'needs_check'))
    .orderBy(desc(captures.createdAt))
    .limit(limit)

  const ids = rows.map((r) => r.place.id)
  const allMentions = ids.length
    ? await db.select().from(mentions).where(inArray(mentions.placeId, ids))
    : []

  return rows.map(({ place, capture }) => ({
    ...toPlace(place),
    mentions: allMentions.filter((m) => m.placeId === place.id).map(toMention),
    capture: { id: capture.id, url: capture.url, author: capture.author, platform: capture.platform },
  }))
}

/**
 * Confirmed pins across every capture, collapsed by Google place id — ten reels
 * about one beach are one pin carrying ten sources, not ten pins.
 */
export async function listMapPlaces(): Promise<ApiMapPlace[]> {
  const rows = await db.select().from(places)
    .where(and(eq(places.status, 'confirmed'), isNotNull(places.lat)))

  const byGoogleId = new Map<string, ApiMapPlace>()
  for (const row of rows) {
    const key = row.googlePlaceId ?? `${row.name}:${row.lat}`
    const existing = byGoogleId.get(key)
    if (existing) {
      if (!existing.captureIds.includes(row.captureId)) existing.captureIds.push(row.captureId)
    } else {
      byGoogleId.set(key, { ...toPlace(row), captureIds: [row.captureId] })
    }
  }
  return [...byGoogleId.values()]
}
