/**
 * Offline tests for Stage C — the gate that decides whether a place is real.
 *
 * The fetch is injected, so this runs with no key, no network and no billable
 * request. The cases that matter are the refusals: zero results must come back
 * as needs_check, and a real place with the wrong name must be rejected rather
 * than accepted as a confirmed pin.
 *
 *   npm run smoke:geocode -w @reel/server
 */
import {
  confidenceFor,
  createGeocodeCache,
  geocode,
  geocodeCluster,
  locationFrom,
  queryFor,
  type GeocodeHit,
} from './extract/geocode.ts'
import type { SourceType } from '@reel/shared'

// The tests must prove the no-key path, so a key in the ambient environment
// cannot be allowed to leak in and hide it.
delete process.env.GOOGLE_MAPS_API_KEY

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`)
  if (!ok) failures++
}

const KEY = 'test-key-not-a-real-one'

interface Call {
  url: string
  textQuery: string
  pageSize: number
  fieldMask: string
  apiKey: string
}

/** A place object shaped exactly like Text Search (New) returns one. */
function place(over: Record<string, unknown> = {}) {
  return {
    id: 'ChIJtest',
    displayName: { text: 'Kelingking Beach', languageCode: 'en' },
    formattedAddress: 'Bunga Mekar, Nusa Penida, Bali, Indonesia',
    location: { latitude: -8.7506, longitude: 115.4736 },
    types: ['beach', 'tourist_attraction'],
    ...over,
  }
}

/** Records what was sent and replies with whatever the test wants back. */
function stub(reply: unknown | ((callNumber: number) => unknown)) {
  const calls: Call[] = []
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init.body ?? '{}')) as { textQuery?: string; pageSize?: number }
    const headers = (init.headers ?? {}) as Record<string, string>
    calls.push({
      url,
      textQuery: body.textQuery ?? '',
      pageSize: body.pageSize ?? 0,
      fieldMask: headers['X-Goog-FieldMask'] ?? '',
      apiKey: headers['X-Goog-Api-Key'] ?? '',
    })
    const payload = typeof reply === 'function'
      ? (reply as (n: number) => unknown)(calls.length)
      : reply
    if (payload instanceof Response) return payload
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { fetch, calls }
}

const opts = (fetch: ReturnType<typeof stub>['fetch'], over: Record<string, unknown> = {}) =>
  ({ apiKey: KEY, fetch, cache: createGeocodeCache(), ...over })

async function messageFrom(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
    return ''
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

const cluster = (sources: SourceType[]) => ({ name: 'Kelingking Beach', sources })
const hit: GeocodeHit = {
  placeId: 'ChIJtest', lat: -8.75, lng: 115.47,
  canonicalName: 'Kelingking Beach', address: 'Bali', match: 'exact',
}
/** A single shared token — "Ultraman" answered with "ULTRAMAN STREET". */
const looseHit: GeocodeHit = { ...hit, canonicalName: 'Kelingking Street', match: 'loose' }
/** Google offering a longer name: "Ultraman" -> "ULTRAMAN STREET". */
const prefixHit: GeocodeHit = { ...hit, canonicalName: 'Kelingking Beach Club', match: 'prefix' }

// --- the request ------------------------------------------------------------
console.log('\n\x1b[1mREQUEST\x1b[0m')

{
  const s = stub({ places: [place()] })
  const missing = await messageFrom(() => geocode('Kelingking Beach', { fetch: s.fetch }))
  check('no key throws an error naming the env var',
    missing.includes('GOOGLE_MAPS_API_KEY'), missing.slice(0, 80))
  check('no key fails before spending a request', s.calls.length === 0)
}

{
  const s = stub({ places: [place()] })
  await geocode('Kelingking Beach', opts(s.fetch))
  const call = s.calls[0]
  check('posts to the Places API (New) text search endpoint',
    call?.url === 'https://places.googleapis.com/v1/places:searchText', call?.url ?? '')
  check('sends the key as X-Goog-Api-Key', call?.apiKey === KEY)
  // The field mask is the bill — anything extra here silently costs money on
  // every capture, so it is pinned rather than eyeballed.
  check('requests only the fields it needs (field mask drives billing)',
    call?.fieldMask === 'places.id,places.displayName,places.formattedAddress,places.location,places.types',
    call?.fieldMask ?? '')
  check('asks for a small page of candidates', call?.pageSize === 3, String(call?.pageSize))
}

// --- destination scoping ----------------------------------------------------
console.log('\n\x1b[1mDESTINATION SCOPING\x1b[0m')

{
  const s = stub({ places: [place({ displayName: { text: 'Blue Lagoon' } })] })
  await geocode('Blue Lagoon', opts(s.fetch))
  await geocode('Blue Lagoon', opts(s.fetch, { destination: 'Iceland' }))
  check('unscoped query is the bare name', s.calls[0]?.textQuery === 'Blue Lagoon', s.calls[0]?.textQuery ?? '')
  // The Iceland lagoon and the Malta beach are both called this. Without the
  // destination the top result is a coin toss.
  check('destination scoping changes the query sent',
    s.calls[1]?.textQuery === 'Blue Lagoon, Iceland', s.calls[1]?.textQuery ?? '')
}

check('does not repeat a destination the name already carries',
  queryFor('Nusa Penida Bali', 'Bali') === 'Nusa Penida Bali',
  queryFor('Nusa Penida Bali', 'Bali'))

// --- the gate ---------------------------------------------------------------
console.log('\n\x1b[1mTHE GATE\x1b[0m')

{
  const s = stub({ places: [place()] })
  const found = await geocode('Kelingking Beach', opts(s.fetch, { destination: 'Bali' }))
  check('a clean hit returns placeId, lat and lng',
    found?.placeId === 'ChIJtest' && found?.lat === -8.7506 && found?.lng === 115.4736,
    JSON.stringify(found))
  check('a clean hit carries Google’s spelling and address',
    found?.canonicalName === 'Kelingking Beach' && found?.address?.includes('Nusa Penida') === true)

  const located = locationFrom(cluster(['caption']), found)
  check('a clean hit is status confirmed', located.status === 'confirmed', located.status)
}

{
  // The whole reason this stage exists. A café that does not exist cannot be
  // resolved, and the honest answer is needs_check — not a nearby guess.
  const s = stub({ places: [] })
  const missed = await geocode('Warung Sunset Paradise', opts(s.fetch, { destination: 'Bali' }))
  check('ZERO RESULTS returns no hit', missed === null, JSON.stringify(missed))

  const located = locationFrom(cluster(['caption', 'transcript']), missed)
  check('zero results yields needs_check, never a guess',
    located.status === 'needs_check' && located.placeId === null
    && located.lat === null && located.lng === null && located.canonicalName === null,
    JSON.stringify(located))
}

{
  // proto3 JSON drops empty repeated fields, so a no-match can come back as {}
  // with no `places` key at all.
  const s = stub({})
  check('an empty response body is treated as zero results',
    (await geocode('Warung Sunset Paradise', opts(s.fetch))) === null)
}

{
  // Google always answers *something*. For an invented place that something is
  // a real, nearby, differently named business — accepting it would launder a
  // hallucination into a verified pin.
  const s = stub({ places: [place({ displayName: { text: 'Kelingking Beach' } })] })
  const wrong = await geocode('Warung Sunset Paradise', opts(s.fetch, { destination: 'Bali' }))
  check('REJECTS a returned place whose name is unlike the query', wrong === null,
    JSON.stringify(wrong))
  check('a rejected match is status needs_check, not confirmed',
    locationFrom(cluster(['caption']), wrong).status === 'needs_check')
}

{
  // Rejecting must not be so strict that honest results die: Google routinely
  // returns the fuller official name.
  const s = stub({ places: [place({ displayName: { text: 'Mandarake Shibuya' } })] })
  const found = await geocode('Mandarake', opts(s.fetch, { destination: 'Tokyo' }))
  check('accepts Google’s fuller spelling of the same place',
    found?.canonicalName === 'Mandarake Shibuya', JSON.stringify(found))
}

{
  // A result with no coordinates cannot be pinned, so it is no result rather
  // than a "confirmed" place with null lat/lng.
  const s = stub({ places: [place({ location: undefined })] })
  check('a result missing coordinates is not a confirmation',
    (await geocode('Kelingking Beach', opts(s.fetch))) === null)
}

{
  // An outage is not evidence about the place, so it must not quietly become
  // needs_check — it throws, and it is not remembered as a verdict.
  const s = stub(() => new Response('{"error":{"message":"bad request"}}', { status: 400 }))
  const o = opts(s.fetch)
  const msg = await messageFrom(() => geocode('Kelingking Beach', o))
  check('an API failure throws rather than passing as "no such place"',
    msg.includes('400'), msg.slice(0, 90))
  await messageFrom(() => geocode('Kelingking Beach', o))
  check('a failed lookup is not cached as an answer', s.calls.length === 2, String(s.calls.length))
}

// --- cache ------------------------------------------------------------------
console.log('\n\x1b[1mCACHE\x1b[0m')

{
  const s = stub({ places: [place()] })
  const o = opts(s.fetch, { destination: 'Bali' })
  const first = await geocode('Kelingking Beach', o)
  const second = await geocode('kelingking beach', o)
  check('a repeated name does not cost a second call', s.calls.length === 1, `${s.calls.length} call(s)`)
  check('the cached answer is the same result', first?.placeId === second?.placeId)

  // Parallel clusters must share one in-flight request, not race into two.
  const p = stub({ places: [place({ id: 'ChIJparallel' })] })
  const po = opts(p.fetch)
  await Promise.all([geocode('Angel Billabong', po), geocode('Angel Billabong', po)])
  check('parallel lookups of one name share a single request', p.calls.length === 1,
    `${p.calls.length} call(s)`)
}

{
  const s = stub({ places: [place()] })
  const o = opts(s.fetch)
  await geocode('Blue Lagoon', o)
  await geocode('Blue Lagoon', { ...o, destination: 'Iceland' })
  check('a different destination is a different query, not a cache hit',
    s.calls.length === 2, `${s.calls.length} call(s)`)
}

{
  // Two spellings, one real place: dedupe by placeId so downstream grouping
  // gets identity rather than two objects describing one beach.
  const s = stub((n: number) => ({
    places: [place({ displayName: { text: n === 1 ? 'Kelingking Beach' : 'Kelingking' } })],
  }))
  const o = opts(s.fetch)
  const a = await geocode('Kelingking Beach', o)
  const b = await geocode('Kelingking', o)
  check('two names resolving to one placeId share one object', a === b && a !== null)
}

// --- confidence -------------------------------------------------------------
console.log('\n\x1b[1mCONFIDENCE\x1b[0m')

check('2+ distinct sources AND geocoded = high',
  confidenceFor(cluster(['caption', 'transcript']), hit) === 'high')
check('one source AND geocoded = medium',
  confidenceFor(cluster(['caption']), hit) === 'medium')
check('not geocoded = low, however many sources agreed',
  confidenceFor(cluster(['caption', 'transcript', 'onScreenText']), null) === 'low')
check('repeated source types do not inflate the tier',
  confidenceFor({ sources: ['caption', 'caption'] }, hit) === 'medium')

{
  const s = stub({ places: [place()] })
  const confirmed = await geocodeCluster(
    { name: 'Kelingking Beach', sources: ['caption', 'onScreenText'] },
    opts(s.fetch, { destination: 'Bali' }),
  )
  check('a geocoded cluster with two witnesses is confirmed/high',
    confirmed.status === 'confirmed' && confirmed.confidence === 'high',
    `${confirmed.status}/${confirmed.confidence}`)

  const miss = stub({ places: [] })
  const unresolved = await geocodeCluster(
    { name: 'Warung Sunset Paradise', sources: ['transcript'] },
    opts(miss.fetch, { destination: 'Bali' }),
  )
  check('an unresolved cluster is needs_check/low',
    unresolved.status === 'needs_check' && unresolved.confidence === 'low',
    `${unresolved.status}/${unresolved.confidence}`)
}

// --- graded matching -------------------------------------------------------
// Observed live: Google answered "ULTRAMAN STREET" for "Ultraman" and the
// pipeline reported it confirmed, while "Golden Gai" was rejected outright
// because Google prefixed it as "Shinjuku Golden-Gai". Both were wrong.
console.log('\n\x1b[1mGRADED MATCHING\x1b[0m')

check('a loose match is never presented as confirmed',
  locationFrom(cluster(['caption', 'transcript']), looseHit).status === 'needs_check',
  locationFrom(cluster(['caption', 'transcript']), looseHit).status)
check('a loose match is low confidence however many witnesses agreed',
  confidenceFor(cluster(['caption', 'transcript', 'onScreenText']), looseHit) === 'low')
check('a loose match keeps its coordinates so you can judge it',
  locationFrom(cluster(['caption']), looseHit).lat === -8.75)
check('an exact match is still confirmed',
  locationFrom(cluster(['caption']), hit).status === 'confirmed')
check('a prefix match is needs_check too — Google offering a longer name is a guess',
  locationFrom(cluster(['caption', 'transcript']), prefixHit).status === 'needs_check')
check('a prefix match is low confidence', confidenceFor(cluster(['caption', 'transcript']), prefixHit) === 'low')

console.log(failures === 0 ? '\n\x1b[32mall good\x1b[0m' : `\n\x1b[31m${failures} failed\x1b[0m`)
process.exit(failures === 0 ? 0 : 1)
