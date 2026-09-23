import type { Confidence, PlaceStatus, SourceType } from '@reel/shared'
import { withRetry } from '../lib/retry.ts'
import { samePlace } from './reconcile.ts'
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

function toHit(place: NonNullable<SearchTextResponse['places']>[number]): GeocodeHit | null {
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

/**
 * Resolve one name against Google Places.
 *
 * Returns `null` when nothing matched — that is a real answer, and the caller
 * must render it as `needs_check`. A thrown error is a different thing: it
 * means the lookup never happened (no key, API down, network gone), which is
 * not evidence about the place, so callers should surface it as an outage
 * rather than as an unverified place.
 */
export async function geocode(
  name: string,
  opts: GeocodeOpts = {},
  onRetry?: OnRetry,
): Promise<GeocodeHit | null> {
  const trimmed = name.trim()
  if (!trimmed) return null

  const query = queryFor(trimmed, opts.destination)
  const cache = opts.cache ?? defaultCache
  const key = normalizeForMatch(query)

  const cached = cache.byQuery.get(key)
  if (cached) return cached

  const pending = lookup(trimmed, query, opts, onRetry)
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
          languageCode: opts.languageCode ?? 'en',
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

  for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
    const hit = toHit(candidate)
    if (!hit) continue
    // The gate. Google always answers something, and for an invented café that
    // something is a real, nearby, differently-named business. Accepting it
    // would launder a hallucination into a verified pin with coordinates.
    //
    // samePlace is the same comparison that decided two mentions were one
    // place, so a name Google spells slightly differently ("Kelingking Beach"
    // for "Kelingking") passes for the same reasons it passed in reconcile.
    if (!samePlace(name, hit.canonicalName)) continue
    return hit
  }

  return null
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
