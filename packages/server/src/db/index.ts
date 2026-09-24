import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import * as schema from './schema.ts'

export * as schema from './schema.ts'
export { captures, places, mentions, tips, facts, rejections } from './schema.ts'

/**
 * One SQLite file under the work directory. `DATABASE_URL` overrides it, so the
 * same code points at Turso or Postgres later without touching a query.
 */
const LIBSQL_SCHEMES = ['libsql:', 'file:', 'http:', 'https:', 'ws:', 'wss:']

function databaseUrl(): string {
  const configured = process.env.DATABASE_URL?.trim()

  if (configured) {
    // A postgres:// URL here is almost always a leftover from the env template
    // rather than an intent. Falling back to the local file with a warning beats
    // crashing on a driver error that says nothing about what to do next.
    if (LIBSQL_SCHEMES.some((s) => configured.startsWith(s))) return configured
    console.warn(
      `DATABASE_URL is "${configured.split(':')[0]}:" which this driver cannot use — ` +
      'falling back to the local SQLite file. Unset it, or use a libsql:/file: URL.',
    )
  }

  const dir = path.resolve(process.cwd(), process.env.WORK_DIR || '.work')
  mkdirSync(dir, { recursive: true })
  return `file:${path.join(dir, 'reel-trip.db')}`
}

export const db = drizzle(createClient({ url: databaseUrl() }), { schema })

/**
 * Schema as plain DDL rather than a migration toolchain.
 *
 * At this size a generated migration folder is ceremony: there is one developer,
 * one database file, and it can be deleted and rebuilt from the .work captures.
 * When there is data worth preserving, switch to drizzle-kit — the schema is
 * already declared in Drizzle, so nothing has to be rewritten to get there.
 */
const DDL = [
  `CREATE TABLE IF NOT EXISTS captures (
    id TEXT PRIMARY KEY, url TEXT NOT NULL, platform TEXT NOT NULL,
    profile TEXT NOT NULL DEFAULT 'travel', status TEXT NOT NULL DEFAULT 'queued',
    step TEXT, error TEXT, author TEXT, posted_at TEXT, caption TEXT,
    duration_seconds REAL, destination TEXT, skipped_asr_reason TEXT,
    ocr_failed_frames INTEGER NOT NULL DEFAULT 0,
    rejected_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS captures_status_idx ON captures(status, created_at)`,

  `CREATE TABLE IF NOT EXISTS places (
    id TEXT PRIMARY KEY,
    capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
    name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'other',
    status TEXT NOT NULL, confidence TEXT NOT NULL,
    place_id TEXT, lat REAL, lng REAL, canonical_name TEXT, address TEXT,
    first_seconds REAL, reviewed_by TEXT)`,
  `CREATE INDEX IF NOT EXISTS places_capture_idx ON places(capture_id)`,
  `CREATE INDEX IF NOT EXISTS places_google_idx ON places(place_id)`,
  `CREATE INDEX IF NOT EXISTS places_status_idx ON places(status)`,

  `CREATE TABLE IF NOT EXISTS mentions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    place_id TEXT NOT NULL REFERENCES places(id) ON DELETE CASCADE,
    raw_name TEXT NOT NULL, source_quote TEXT NOT NULL, source_type TEXT NOT NULL,
    source_seconds REAL, asr_confidence REAL)`,
  `CREATE INDEX IF NOT EXISTS mentions_place_idx ON mentions(place_id)`,

  `CREATE TABLE IF NOT EXISTS tips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
    place_id TEXT REFERENCES places(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, text TEXT NOT NULL, source_quote TEXT NOT NULL,
    source_type TEXT NOT NULL, source_seconds REAL)`,
  `CREATE INDEX IF NOT EXISTS tips_capture_idx ON tips(capture_id)`,
  `CREATE INDEX IF NOT EXISTS tips_place_idx ON tips(place_id)`,

  `CREATE TABLE IF NOT EXISTS facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
    place_id TEXT REFERENCES places(id) ON DELETE CASCADE,
    label TEXT NOT NULL, value TEXT NOT NULL, source_quote TEXT NOT NULL,
    source_type TEXT NOT NULL, source_seconds REAL)`,
  `CREATE INDEX IF NOT EXISTS facts_capture_idx ON facts(capture_id)`,
  `CREATE INDEX IF NOT EXISTS facts_place_idx ON facts(place_id)`,

  `CREATE TABLE IF NOT EXISTS rejections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
    reason TEXT NOT NULL, detail TEXT)`,
  `CREATE INDEX IF NOT EXISTS rejections_capture_idx ON rejections(capture_id)`,
]

/**
 * Drizzle wraps driver errors: the top-level message is "Failed query: ALTER
 * TABLE ..." and SQLite's "duplicate column name" sits a level or two down in
 * `cause`. Checking only the top message would crash every restart against a
 * database that already has the column.
 */
function mentionsDuplicateColumn(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    if (/duplicate column/i.test(String((e as Error).message ?? e))) return true
  }
  return false
}

let ready: Promise<void> | null = null

/**
 * Columns added after the first release. CREATE TABLE IF NOT EXISTS never
 * touches a table that already exists, so a database created before a column
 * existed needs it added explicitly — and SQLite has no ADD COLUMN IF NOT
 * EXISTS, so the duplicate-column error is the signal it is already there.
 */
const ADDED_COLUMNS = [
  `ALTER TABLE places ADD COLUMN reviewed_by TEXT`,
]

/** Idempotent. Safe to call on every server start. */
export function migrate(): Promise<void> {
  ready ??= (async () => {
    for (const statement of DDL) await db.run(statement)
    for (const statement of ADDED_COLUMNS) {
      try {
        await db.run(statement)
      } catch (err) {
        if (!mentionsDuplicateColumn(err)) throw err
      }
    }
  })()
  return ready
}
