/**
 * The whole of Stage B + C — interpret, verify, reconcile, geocode — run
 * offline with a scripted model and a scripted Google.
 *
 * The pieces each have their own tests; this checks they compose. It is also
 * where "a country is not a pin" is pinned down, since that rule only exists in
 * the orchestrator.
 *
 *   npm run smoke:orchestrate -w @reel/server
 */
import type { EvidenceBundle } from '@reel/shared'
import { extract, isRegion } from './extract/index.ts'
import { createGeocodeCache } from './extract/geocode.ts'
import type { ModelRequest } from './extract/interpret.ts'

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`)
  if (!ok) failures++
}
const section = (t: string) => console.log(`\n\x1b[1m${t}\x1b[0m`)

// A reel shaped like the real Tokyo nerd-bar capture.
const bundle = {
  captureId: 'orch00000001', platform: 'instagram', url: 'https://www.instagram.com/reel/X/',
  author: 'johnmarcoasks', postedAt: null,
  caption: { text: 'Nerd-core bars in Tokyo, Japan', hashtags: [], locationTag: null },
  transcript: {
    text: 'Right here in Ebisu is Janai Coffee. Go on the website to get the password. Japan has the best bars.',
    words: [
      { word: 'Ebisu', startMs: 32600, endMs: 33000, confidence: 0.9 },
      { word: 'Janai', startMs: 33400, endMs: 33800, confidence: 0.9 },
      { word: 'Coffee', startMs: 33800, endMs: 34200, confidence: 0.9 },
      { word: 'Japan', startMs: 49900, endMs: 50300, confidence: 0.9 },
    ],
    language: 'en', pass: 1, vocabulary: [],
  },
  transcriptPass1: null, onScreenText: [],
  ocrFailedFrames: 0, ocrProvider: null, audioSource: 'video', skippedAsrReason: null,
  biasVerdict: null, corroborationTerms: [], durationSeconds: 66, imageRefs: [],
  createdAt: new Date().toISOString(),
} as unknown as EvidenceBundle

/** The model, scripted per source. Every quote below really is in the bundle. */
const replies: Record<string, unknown> = {
  caption: {
    mentions: [
      { rawName: 'Tokyo', sourceQuote: 'Nerd-core bars in Tokyo, Japan' },
      { rawName: 'Japan', sourceQuote: 'Nerd-core bars in Tokyo, Japan' },
    ],
    tips: [], facts: [], destination: null,
  },
  transcript: {
    mentions: [
      { rawName: 'Ebisu', sourceQuote: 'Right here in Ebisu is Janai Coffee' },
      { rawName: 'Janai Coffee', sourceQuote: 'Right here in Ebisu is Janai Coffee' },
      { rawName: 'Japan', sourceQuote: 'Japan has the best bars' },
    ],
    tips: [
      { kind: 'hack', text: 'Get the password from the website', sourceQuote: 'Go on the website to get the password', aboutPlace: 'Janai Coffee' },
      // Advice attached to a REGION. When Japan stops being a pin, this must
      // survive as trip-level advice rather than vanish with it.
      { kind: 'do', text: 'Japan has great bars', sourceQuote: 'Japan has the best bars', aboutPlace: 'Japan' },
    ],
    facts: [], destination: null,
  },
}

const fakeModel = async (req: ModelRequest) => {
  const source = req.label.replace(/^interpret\s+/, '')
  return JSON.stringify(replies[source] ?? { mentions: [], tips: [], facts: [], destination: null })
}

/** Google, scripted: the types are exactly what the live API returned. */
const google: Record<string, { name: string; types: string[] }> = {
  tokyo: { name: 'Tokyo', types: ['administrative_area_level_1', 'political'] },
  japan: { name: 'Japan', types: ['country', 'political'] },
  ebisu: { name: 'Ebisu', types: ['sublocality_level_2', 'sublocality', 'political'] },
  'janai coffee': { name: 'JANAI COFFEE', types: ['cafe', 'food', 'establishment'] },
}
let googleCalls = 0
const fakeFetch = async (_url: string, init?: { body?: string }) => {
  googleCalls++
  const query = String(JSON.parse(init?.body ?? '{}').textQuery ?? '').toLowerCase()
  const key = Object.keys(google).find((k) => query.startsWith(k))
  const hit = key ? google[key]! : null
  const body = hit ? {
    places: [{
      id: `ChIJ-${key}`, displayName: { text: hit.name }, formattedAddress: `${hit.name}, somewhere`,
      location: { latitude: 35.6, longitude: 139.7 }, types: hit.types,
    }],
  } : {}
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

const result = await extract(bundle, {
  interpretCall: fakeModel,
  geocode: { apiKey: 'test', fetch: fakeFetch as never, cache: createGeocodeCache() },
})
const names = result.places.map((p) => p.name)

section('A COUNTRY IS NOT A PIN')
check('the country type is a region', isRegion(['country', 'political']))
check('a first-level admin area (Tokyo, Bali) is a region', isRegion(['administrative_area_level_1', 'political']))
check('a locality (Kyoto, Ubud) is NOT — in a multi-city trip it is a stop', !isRegion(['locality', 'political']))
check('Japan does not become a place', !names.includes('Japan'), names.join(' | '))
check('Tokyo does not become a place', !names.includes('Tokyo'))
check('the region becomes the destination, most specific first', result.destination === 'Tokyo', String(result.destination))
check('advice about the region survives as trip-level advice',
  result.generalTips.some((t) => t.text === 'Japan has great bars'),
  result.generalTips.map((t) => t.text).join(' | '))

section('REAL STOPS STAY')
const janai = result.places.find((p) => p.name === 'Janai Coffee')
check('a business is kept and confirmed', janai?.status === 'confirmed', janai?.status ?? 'missing')
check('a neighbourhood is kept', names.includes('Ebisu'))
check('kind comes from Google, not the model', janai?.kind === 'cafe', janai?.kind ?? '')
check('a tip stays attached to its place', janai?.tips.some((t) => t.kind === 'hack') === true)
check('the mention carries the second it was said',
  janai?.mentions.some((m) => m.sourceType === 'transcript' && m.sourceSeconds === 33.4) === true,
  JSON.stringify(janai?.mentions.map((m) => m.sourceSeconds)))

section('THE GUARD STILL HOLDS END TO END')
// Same pipeline, but the model invents a place with a quote that is not in the reel.
replies.transcript = {
  mentions: [{ rawName: 'Sunset Paradise Bar', sourceQuote: 'the best bar is Sunset Paradise Bar' }],
  tips: [], facts: [], destination: null,
}
replies.caption = { mentions: [], tips: [], facts: [], destination: null }
const invented = await extract(bundle, {
  interpretCall: fakeModel,
  geocode: { apiKey: 'test', fetch: fakeFetch as never, cache: createGeocodeCache() },
})
check('an invented place never reaches the result', invented.places.length === 0,
  invented.places.map((p) => p.name).join(' | '))
check('...and the drop is recorded, not silent', invented.rejected.length === 1,
  invented.rejected[0]?.reason ?? '')

const before = googleCalls
await extract(bundle, { interpretCall: fakeModel, geocode: false })
check('geocode: false makes no Google calls', googleCalls === before)

console.log(failures === 0 ? '\n\x1b[32mall good\x1b[0m' : `\n\x1b[31m${failures} failed\x1b[0m`)
process.exit(failures === 0 ? 0 : 1)
