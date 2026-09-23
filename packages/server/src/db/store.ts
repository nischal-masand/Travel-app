import { and, desc, eq, isNotNull, sql } from 'drizzle-orm'
import type { CaptureResult, EvidenceBundle } from '@reel/shared'
import { db, captures, facts, mentions, places, rejections, tips } from './index.ts'

/**
 * Persisting a capture writes the evidence alongside the conclusion — every
 * mention with its source and its second. Without that the app can show a pin
 * but not why it believes in it, and "why do you believe this" is the entire
 * product.
 */

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

/** Replaces any previous result for this capture, so a re-run is clean. */
export async function saveResult(
  bundle: EvidenceBundle,
  result: CaptureResult,
): Promise<void> {
  const id = bundle.captureId

  // Children cascade, but libSQL does not enforce foreign keys by default, so
  // clear them explicitly rather than relying on a pragma being set.
  for (const table of [mentions, tips, facts, rejections]) {
    if (table === mentions) {
      await db.delete(mentions).where(sql`place_id IN (SELECT id FROM places WHERE capture_id = ${id})`)
    } else {
      await db.delete(table).where(eq((table as typeof tips).captureId, id))
    }
  }
  await db.delete(places).where(eq(places.captureId, id))

  await db.update(captures).set({
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
    ocrFailedFrames: bundle.ocrFailedFrames,
    rejectedCount: result.rejected.length,
    completedAt: new Date().toISOString(),
  }).where(eq(captures.id, id))

  for (const place of result.places) {
    await db.insert(places).values({
      id: place.id,
      captureId: id,
      name: place.name,
      kind: place.kind,
      status: place.status,
      confidence: place.confidence,
      placeId: place.placeId,
      lat: place.lat,
      lng: place.lng,
      canonicalName: place.canonicalName,
      address: place.address,
      firstSeconds: place.mentions
        .map((m) => m.sourceSeconds)
        .filter((s): s is number => s !== null)
        .sort((a, b) => a - b)[0] ?? null,
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
    for (const t of place.tips) {
      await db.insert(tips).values({ captureId: id, placeId: place.id, ...pick(t) })
    }
    for (const f of place.facts) {
      await db.insert(facts).values({ captureId: id, placeId: place.id, ...pickFact(f) })
    }
  }

  for (const t of result.generalTips) {
    await db.insert(tips).values({ captureId: id, placeId: null, ...pick(t) })
  }
  for (const f of result.generalFacts) {
    await db.insert(facts).values({ captureId: id, placeId: null, ...pickFact(f) })
  }
  for (const r of result.rejected) {
    await db.insert(rejections).values({ captureId: id, reason: r.reason, detail: null })
  }
}

const pick = (t: CaptureResult['generalTips'][number]) => ({
  kind: t.kind, text: t.text, sourceQuote: t.sourceQuote,
  sourceType: t.sourceType, sourceSeconds: t.sourceSeconds,
})

const pickFact = (f: CaptureResult['generalFacts'][number]) => ({
  label: f.label, value: f.value, sourceQuote: f.sourceQuote,
  sourceType: f.sourceType, sourceSeconds: f.sourceSeconds,
})

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listCaptures(limit = 50) {
  return db.select().from(captures).orderBy(desc(captures.createdAt)).limit(limit)
}

export async function getCapture(id: string) {
  const [capture] = await db.select().from(captures).where(eq(captures.id, id))
  if (!capture) return null

  const rows = await db.select().from(places).where(eq(places.captureId, id))
  const detailed = await Promise.all(rows.map(async (p) => ({
    ...p,
    mentions: await db.select().from(mentions).where(eq(mentions.placeId, p.id)),
    tips: await db.select().from(tips).where(eq(tips.placeId, p.id)),
    facts: await db.select().from(facts).where(eq(facts.placeId, p.id)),
  })))

  return {
    capture,
    places: detailed,
    generalTips: await db.select().from(tips).where(and(eq(tips.captureId, id), sql`place_id IS NULL`)),
    generalFacts: await db.select().from(facts).where(and(eq(facts.captureId, id), sql`place_id IS NULL`)),
    rejected: await db.select().from(rejections).where(eq(rejections.captureId, id)),
  }
}

/** Everything awaiting your judgement, newest first. The tray. */
export async function listNeedsCheck(limit = 100) {
  const rows = await db.select().from(places)
    .where(eq(places.status, 'needs_check'))
    .limit(limit)
  return Promise.all(rows.map(async (p) => ({
    ...p,
    mentions: await db.select().from(mentions).where(eq(mentions.placeId, p.id)),
  })))
}

/**
 * Confirmed pins across every capture, collapsed by Google place id — ten reels
 * about one beach are one pin carrying ten sources, not ten pins.
 */
export async function listMapPlaces() {
  const rows = await db.select().from(places)
    .where(and(eq(places.status, 'confirmed'), isNotNull(places.lat)))

  const byGoogleId = new Map<string, typeof rows[number] & { captureIds: string[] }>()
  for (const row of rows) {
    const key = row.placeId ?? `${row.name}:${row.lat}`
    const existing = byGoogleId.get(key)
    if (existing) existing.captureIds.push(row.captureId)
    else byGoogleId.set(key, { ...row, captureIds: [row.captureId] })
  }
  return [...byGoogleId.values()]
}
