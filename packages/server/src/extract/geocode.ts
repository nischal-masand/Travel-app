import type { Confidence, PlaceStatus, SourceType } from '@reel/shared'
import { withRetry } from '../lib/retry.ts'
import { matchStrength, type MatchStrength } from './reconcile.ts'
import { normalizeForMatch } from './verify.ts'

/**
 * STAGE C — the second gate: does this place actually exist?
 *
 * Stage B's quote check proves the model did not invent the *words*. It cannot
 * prove the words describe a real café. That is what this file is for: a name
 * that Google Places cannot resolve does not get a pin, a lat/lng, or the word
 * "confirmed" next to it.
 *
 * The one rule that matters here is what happens on a miss. A missing result is
 * reported as `needs_check` — never dropped (the user still said it, and the
 * evidence trail still stands), and never filled in with a nearby place that
 * happens to rank first. Guessing is the exact failure this stage exists to
 * prevent, and it is worse than an honest "couldn't verify this one", because
 * you only discover it standing on the street looking for it.
 */

const ENDPOINT = 'https://places.googleapis.com/v1/places:searchText'

/**
 * The field mask is the bill. Text Search (New) charges by the most expensive
 * field requested: `places.id` alone stays in the Essentials (IDs Only) SKU,
 * while displayName / formattedAddress / location move the whole request to
 * Pro. We need the coordinates to drop a pin and the display name to check the
 * match, so Pro is unavoidable — but `types` rides along in the same SKU, and
 * nothing beyond this list is requested. Adding photos, opening hours or
 * reviews here would silently move every capture to Enterprise pricing.
 */
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.types',
].join(',')

/**
 * Google ranks well, so the answer is nearly always first. A few candidates are
 * fetched anyway because a query scoped by destination sometimes puts the
 * region itself on top — but every candidate still has to pass the name check
 * below, so scanning further down can never turn into accepting a bad match.
 * More candidates costs nothing extra: billing is per request, not per result.
 */
const MAX_CANDIDATES = 3

export type OnRetry = (attempt: number, waitMs: number, err: unknown) => void

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

/** A place Google could resolve. Its existence is the point; the fields follow. */
export interface GeocodeHit {
  placeId: string
  lat: number
  lng: number
  /** Google's own spelling, which may differ from the reel's. */
  canonicalName: string
  address: string | null
  /** How well Google's name matched what we asked for. Drives status. */
  match: MatchStrength
  types?: string[]
}

export interface GeocodeOpts {
  /**
   * Region or country from the capture. "Blue Lagoon" is a lagoon in Iceland
   * and a beach in Malta; without this the top result is a coin toss, and a
   * confidently wrong pin is the worst thing this stage can produce.
   */
  destination?: string | null
  /** Overrides the env var. Used by the offline tests. */
  apiKey?: string
  /** Injected so the tests can run with no key and no network. */
  fetch?: FetchLike
  /** Defaults to the per-process cache; pass one to isolate a run. */
  cache?: GeocodeCache
  languageCode?: string
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/**
 * Ten reels about Bali name Kelingking Beach ten times, and the clusters are
 * per-capture so they cannot see each other. Caching by query keeps that one
 * request; caching by placeId makes the ten results one object, so anything
 * downstream that groups places across captures gets identity for free.
 */
export interface GeocodeCache {
  /** Promises, not values, so parallel lookups of one name share a request. */
  byQuery: Map<string, Promise<GeocodeHit | null>>
  byPlaceId: Map<string, GeocodeHit>
}

export function createGeocodeCache(): GeocodeCache {
  return { byQuery: new Map(), byPlaceId: new Map() }
}

let defaultCache = createGeocodeCache()

/** Drops everything cached so far. One run, one cache. */
export function resetGeocodeCache(): void {
  defaultCache = createGeocodeCache()
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

function apiKeyOr(explicit?: string): string {
  const key = explicit ?? process.env.GOOGLE_MAPS_API_KEY
  if (!key) {
    throw new Error(
      'Missing GOOGLE_MAPS_API_KEY. Geocoding is the check that a place exists, ' +
      'so there is no fallback worth having — without it every place would be ' +
      'unverified. Copy .env.example to .env and add a key from ' +
      'https://console.cloud.google.com/apis/credentials with the Places API (New) enabled.',
    )
  }
  return key
}

/**
 * Scope the query by destination, unless the name already carries it —
 * "Nusa Penida Bali, Bali" searches worse than either half.
 */
export function queryFor(name: string, destination?: string | null): string {
  const place = name.trim()
  const dest = destination?.trim()
  if (!dest) return place
  if (normalizeForMatch(place).includes(normalizeForMatch(dest))) return place
  return `${place}, ${dest}`
}

/** Exactly the shape Text Search (New) returns, and nothing we did not ask for. */
interface SearchTextResponse {
  places?: Array<{
    id?: string
    displayName?: { text?: string; languageCode?: string }
    formattedAddress?: string
    location?: { latitude?: number; longitude?: number }
    types?: string[]
  }>
}

function toHit(place: NonNullable<SearchTextResponse['places']>[number]): Omit<GeocodeHit, 'match'> | null {
  const placeId = place.id
  const canonicalName = place.displayName?.text?.trim()
  const lat = place.location?.latitude
  const lng = place.location?.longitude
  // A partial result is not a confirmation. Anything missing an id or
  // coordinates cannot be pinned, so it counts as no result rather than as a
  // half-verified place with null fields the UI would have to explain.
  if (!placeId || !canonicalName) return null
  if (typeof lat !== 'number' || typeof lng !== 'number') return null
  return {
    placeId,
    lat,
    lng,
    canonicalName,
    address: place.formattedAddress?.trim() || null,
    ...(place.types?.length ? { types: place.types } : {}),
  }
}

// ---------------------------------------------------------------------------
// Language, form words and regions
// ---------------------------------------------------------------------------

const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u
const HANGUL = /\p{Script=Hangul}/u
const THAI = /\p{Script=Thai}/u
const HAN = /\p{Script=Han}/u

/**
 * Ask Google in the language the name is written in.
 *
 * Asking in English for "父島" gets back "Chichi-jima" — the right island, in a
 * script the name check can never match, so every Japanese-script name on a
 * bilingual caption failed. Asked in Japanese, Google answers "父島".
 *
 * Han characters alone are ambiguous between Japanese and Chinese; the
 * destination decides, and Japanese is the default. Google's text search still
 * finds a Chinese place under a Japanese language code — the code only changes
 * which name it hands back.
 */
export function languageFor(name: string, destination?: string | null): string {
  if (KANA.test(name)) return 'ja'
  if (HANGUL.test(name)) return 'ko'
  if (THAI.test(name)) return 'th'
  if (HAN.test(name)) {
    const d = (destination ?? '').toLowerCase()
    return /china|taiwan|hong kong|macau|beijing|shanghai|taipei|中国|台湾|香港/.test(d) ? 'zh' : 'ja'
  }
  return 'en'
}

/**
 * Words that name the FORM of a place rather than a different place: a village
 * called Kozushima is Kozushima. Google appends them freely ("Kozushima
 * Village", "Yuhigaura Beach", "Shinjuku City"), and without this each of those
 * right answers was held back as a loose match.
 *
 * Deliberately absent: street, road, station, store, shop, cafe, bar, hotel.
 * Those name a NEW thing that merely shares a word — "ULTRAMAN STREET" is not
 * Ultraman — so they must keep blocking a confident match. 島 (island) is also
 * absent: it is part of the name itself in 父島 and 神津島.
 */
const FORM_SUFFIX = /[\s-]*(?:village|town|city|ward|island|islands|isle|beach|bay|lake|falls|村|町|市|区)$/iu

function withoutFormSuffix(name: string): string {
  const stripped = name.trim().replace(FORM_SUFFIX, '').trim()
  const letters = normalizeForMatch(stripped).replace(/[^\p{L}\p{N}]/gu, '')
  return letters.length >= 2 ? stripped : name.trim()
}

/** matchStrength, but tolerant of a form word on either side. */
export function gradeMatch(queried: string, googleName: string): MatchStrength {
  const direct = matchStrength(queried, googleName)
  if (direct === 'exact' || direct === 'strong') return direct
  const bare = matchStrength(withoutFormSuffix(queried), withoutFormSuffix(googleName))
  return bare === 'exact' || bare === 'strong' ? 'strong' : direct
}

/**
 * Google's labels for places that CONTAIN a trip rather than being a stop on
 * it — checked against the live API: "Japan" is `country`, "Tokyo" and "Bali"
 * are `administrative_area_level_1`. `locality` is deliberately excluded: Kyoto,
 * Ubud and Shinjuku are locality, and in a multi-city trip they are stops.
 */
const REGION_TYPES = new Set(['country', 'administrative_area_level_1'])

export function isRegion(types: string[] | undefined): boolean {
  return (types ?? []).some((t) => REGION_TYPES.has(t))
}

const RANK: Record<MatchStrength, number> = { exact: 3, strong: 2, prefix: 1, loose: 1, none: 0 }
const confident = (h: GeocodeHit | null) => h !== null && (h.match === 'exact' || h.match === 'strong')

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * Resolve one name against Google Places.
 *
 * Returns `null` when nothing matched — a real answer, which the caller must
 * render as `needs_check`. A thrown error is different: the lookup never
 * happened (no key, API down), which is not evidence about the place.
 *
 * Scoped first, then bare. Scoping by destination stops "Blue Lagoon" landing
 * in Iceland when the reel was about Malta — but breaks any name BROADER than
 * the destination: "Japan, Tokyo" comes back as Tokyo. So a scoped miss gets
 * one unscoped retry, and because a bare query has lost its disambiguation,
 * only a country or first-level region (unique worldwide) is trusted from it.
 * Anything else found that way is offered as a suggestion, never confirmed.
 */
export async function geocode(
  name: string,
  opts: GeocodeOpts = {},
  onRetry?: OnRetry,
): Promise<GeocodeHit | null> {
  const trimmed = name.trim()
  if (!trimmed) return null

  const lang = opts.languageCode ?? languageFor(trimmed, opts.destination)
  const scopedQuery = queryFor(trimmed, opts.destination)
  const scoped = await cachedLookup(trimmed, scopedQuery, lang, opts, onRetry)
  if (confident(scoped) || scopedQuery === trimmed) return scoped

  let bare = await cachedLookup(trimmed, trimmed, lang, opts, onRetry)
  if (bare && confident(bare) && !isRegion(bare.types)) bare = { ...bare, match: 'loose' }
  if (!bare) return scoped
  if (!scoped) return bare
  return RANK[bare.match] > RANK[scoped.match] ? bare : scoped
}

function cachedLookup(
  name: string,
  query: string,
  lang: string,
  opts: GeocodeOpts,
  onRetry?: OnRetry,
): Promise<GeocodeHit | null> {
  const cache = opts.cache ?? defaultCache
  // Language is part of the question: one query in two languages returns two
  // different names, and only one of them can match.
  const key = `${lang}|${normalizeForMatch(query)}`

  const cached = cache.byQuery.get(key)
  if (cached) return cached

  const pending = lookup(name, query, lang, opts, onRetry)
    .then((hit) => (hit ? dedupe(cache, hit) : null))

  cache.byQuery.set(key, pending)
  // A failed request is an outage, not a verdict. Forget it so the next capture
  // asks again instead of inheriting a network blip as "this place is unknown".
  pending.catch(() => cache.byQuery.delete(key))

  return pending
}

function dedupe(cache: GeocodeCache, hit: GeocodeHit): GeocodeHit {
  const seen = cache.byPlaceId.get(hit.placeId)
  if (seen) return seen
  cache.byPlaceId.set(hit.placeId, hit)
  return hit
}

async function lookup(
  name: string,
  query: string,
  lang: string,
  opts: GeocodeOpts,
  onRetry?: OnRetry,
): Promise<GeocodeHit | null> {
  const key = apiKeyOr(opts.apiKey)
  const doFetch = opts.fetch ?? globalThis.fetch

  const response = await withRetry(
    async () => {
      const r = await doFetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Goog-Api-Key': key,
          'X-Goog-FieldMask': FIELD_MASK,
        },
        body: JSON.stringify({
          textQuery: query,
          languageCode: lang,
          pageSize: MAX_CANDIDATES,
        }),
        signal: AbortSignal.timeout(20_000),
      })
      if (!r.ok) {
        const body = await r.text().catch(() => '')
        // Carry the status so isRetryable can tell a 503 from a bad request.
        throw Object.assign(
          new Error(`Google Places ${r.status}: ${body.slice(0, 200)}`),
          { status: r.status },
        )
      }
      return (await r.json()) as SearchTextResponse
    },
    { label: `google places "${query}"`, attempts: 3, baseMs: 1000, onRetry },
  )

  // Zero results is an empty array, or the field omitted entirely — proto3 JSON
  // drops empty repeated fields, so `{}` comes back for a name nothing matches.
  const candidates = response.places ?? []

  // Google always answers something, and for an invented cafe that something is
  // a real, nearby, differently-named business. Accepting it would launder a
  // hallucination into a verified pin. So every candidate is graded against the
  // queried name; a weak match still reaches you, flagged, rather than being
  // thrown away or dressed up as confirmed.
  let best: GeocodeHit | null = null

  for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
    const hit = toHit(candidate)
    if (!hit) continue

    const match = gradeMatch(name, hit.canonicalName)
    if (match === 'none') continue
    if (match === 'exact' || match === 'strong') return { ...hit, match }
    // 'prefix'/'loose' — one shared token, like "Ultraman" answered with
    // "ULTRAMAN STREET". Held in case nothing better turns up; reaches the user
    // as needs_check, never as a confirmed pin.
    best ??= { ...hit, match }
  }

  return best
}

// ---------------------------------------------------------------------------
// Confidence and the Place fields
// ---------------------------------------------------------------------------

/** Anything with distinct source types — a Cluster satisfies this. */
export interface GeocodeTarget {
  name: string
  sources: readonly SourceType[]
}

/**
 * Two independent witnesses plus a real-world match is as sure as this pipeline
 * gets; one witness plus a match is ordinary and fine; no match is `low`
 * however many sources agreed, because three sources agreeing on a place that
 * does not exist is three sources repeating one caption.
 */
export function confidenceFor(
  cluster: Pick<GeocodeTarget, 'sources'>,
  hit: GeocodeHit | null,
): Confidence {
  if (!hit) return 'low'
  // A loose match is a suggestion, not a verification. Two witnesses agreeing on
  // a name does not make Google's guess at that name right.
  if (hit.match === 'loose' || hit.match === 'prefix') return 'low'
  return new Set(cluster.sources).size >= 2 ? 'high' : 'medium'
}

/** The Place fields this stage owns. Populated iff the place resolved. */
export interface PlaceLocation {
  status: PlaceStatus
  confidence: Confidence
  placeId: string | null
  lat: number | null
  lng: number | null
  canonicalName: string | null
  address: string | null
}

export function locationFrom(
  cluster: Pick<GeocodeTarget, 'sources'>,
  hit: GeocodeHit | null,
): PlaceLocation {
  const confidence = confidenceFor(cluster, hit)
  // A loose hit keeps its coordinates — showing you the candidate is more use
  // than hiding it — but it is NOT confirmed. You decide whether Google
  // understood the name.
  if (hit && (hit.match === 'loose' || hit.match === 'prefix')) {
    return {
      status: 'needs_check',
      confidence,
      placeId: hit.placeId,
      lat: hit.lat,
      lng: hit.lng,
      canonicalName: hit.canonicalName,
      address: hit.address,
    }
  }
  if (!hit) {
    // Everything stays null. A place we could not verify must not carry
    // coordinates, because the UI would draw them on a map as fact.
    return {
      status: 'needs_check',
      confidence,
      placeId: null,
      lat: null,
      lng: null,
      canonicalName: null,
      address: null,
    }
  }
  return {
    status: 'confirmed',
    confidence,
    placeId: hit.placeId,
    lat: hit.lat,
    lng: hit.lng,
    canonicalName: hit.canonicalName,
    address: hit.address,
  }
}

/** Geocode a cluster and return the Place fields for it, hit or miss. */
export async function geocodeCluster(
  cluster: GeocodeTarget,
  opts: GeocodeOpts = {},
  onRetry?: OnRetry,
): Promise<PlaceLocation> {
  const hit = await geocode(cluster.name, opts, onRetry)
  return locationFrom(cluster, hit)
}
