import { sql } from 'drizzle-orm'
import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * SQLite via libSQL — pure JS, so no Docker, no native build and no signup.
 * Drizzle keeps the query layer portable, so this becomes Postgres at deploy
 * time by swapping the driver and the column helpers, not the application code.
 *
 * The shape mirrors the pipeline's honesty rules: a place stores its evidence
 * (every mention, with the source and the second it came from) rather than just
 * a name and a pin, because the whole point is that you can check it.
 */

export const captures = sqliteTable('captures', {
  id: text('id').primaryKey(),
  url: text('url').notNull(),
  platform: text('platform').notNull(),
  profile: text('profile').notNull().default('travel'),

  /** queued -> running -> done | failed */
  status: text('status').notNull().default('queued'),
  step: text('step'),
  error: text('error'),

  author: text('author'),
  postedAt: text('posted_at'),
  caption: text('caption'),
  durationSeconds: real('duration_seconds'),
  destination: text('destination'),

  /** Why a capture came back thin: no speech, unread frames, dropped items. */
  skippedAsrReason: text('skipped_asr_reason'),
  /** Null = recorded before this column existed, so unknown. */
  hasAudio: integer('has_audio', { mode: 'boolean' }),
  ocrFailedFrames: integer('ocr_failed_frames').notNull().default(0),
  rejectedCount: integer('rejected_count').notNull().default(0),

  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  completedAt: text('completed_at'),
}, (t) => [index('captures_status_idx').on(t.status, t.createdAt)])

export const places = sqliteTable('places', {
  id: text('id').primaryKey(),
  captureId: text('capture_id').notNull().references(() => captures.id, { onDelete: 'cascade' }),

  name: text('name').notNull(),
  kind: text('kind').notNull().default('other'),
  status: text('status').notNull(),
  confidence: text('confidence').notNull(),

  /**
   * Google's place id. Named googlePlaceId in code because `placeId` on every
   * child table means OUR place — the same word for two different ids is how
   * a join quietly goes wrong. The column keeps its original name.
   */
  googlePlaceId: text('place_id'),
  lat: real('lat'),
  lng: real('lng'),
  canonicalName: text('canonical_name'),
  address: text('address'),

  /** Earliest moment in the video — drives the frame and clip evidence. */
  firstSeconds: real('first_seconds'),
  /** 'user' once you have confirmed, corrected or dismissed it in the tray. */
  reviewedBy: text('reviewed_by'),
}, (t) => [
  index('places_capture_idx').on(t.captureId),
  // Ten Bali reels naming one beach collapse to one pin with ten sources.
  index('places_google_idx').on(t.googlePlaceId),
  index('places_status_idx').on(t.status),
])

/** The audit trail. One row per source that named the place. */
export const mentions = sqliteTable('mentions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  placeId: text('place_id').notNull().references(() => places.id, { onDelete: 'cascade' }),
  rawName: text('raw_name').notNull(),
  sourceQuote: text('source_quote').notNull(),
  sourceType: text('source_type').notNull(),
  sourceSeconds: real('source_seconds'),
  asrConfidence: real('asr_confidence'),
}, (t) => [index('mentions_place_idx').on(t.placeId)])

export const tips = sqliteTable('tips', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  captureId: text('capture_id').notNull().references(() => captures.id, { onDelete: 'cascade' }),
  /** Null when the tip is about the trip rather than one place. */
  placeId: text('place_id').references(() => places.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  text: text('text').notNull(),
  sourceQuote: text('source_quote').notNull(),
  sourceType: text('source_type').notNull(),
  sourceSeconds: real('source_seconds'),
}, (t) => [index('tips_capture_idx').on(t.captureId), index('tips_place_idx').on(t.placeId)])

export const facts = sqliteTable('facts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  captureId: text('capture_id').notNull().references(() => captures.id, { onDelete: 'cascade' }),
  placeId: text('place_id').references(() => places.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  value: text('value').notNull(),
  sourceQuote: text('source_quote').notNull(),
  sourceType: text('source_type').notNull(),
  sourceSeconds: real('source_seconds'),
}, (t) => [index('facts_capture_idx').on(t.captureId), index('facts_place_idx').on(t.placeId)])

/**
 * Items the model produced that failed the quote check. Kept, not discarded:
 * without them there is no way to tell "this reel named nowhere" apart from
 * "the model named somewhere and could not back it up".
 */
export const rejections = sqliteTable('rejections', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  captureId: text('capture_id').notNull().references(() => captures.id, { onDelete: 'cascade' }),
  reason: text('reason').notNull(),
  detail: text('detail'),
}, (t) => [index('rejections_capture_idx').on(t.captureId)])
