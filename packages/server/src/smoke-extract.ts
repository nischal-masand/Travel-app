/**
 * Offline tests for Stage B's two pure-logic halves: the quote check that keeps
 * invented places out, and the clustering that merges three witnesses' spellings
 * of one real place.
 *
 * No keys, no network, no ffmpeg — so there is no excuse for not running it.
 *
 *   npm run smoke:extract -w @reel/server
 */
import type { EvidenceBundle, Mention } from '@reel/shared'
import { clusterMentions, samePlace, attachToClusters } from './extract/reconcile.ts'
import { normalizeForMatch, verifyMentions, verifyQuotes } from './extract/verify.ts'

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`)
  if (!ok) failures++
}

const bundle = {
  captureId: 't', platform: 'instagram', url: 'u', author: null, postedAt: null,
  caption: {
    text: 'Nusa Penida day trip! Don’t miss Kelingking Beach — boat is 200k IDR.',
    hashtags: ['balitravel'],
    locationTag: 'Nusa Penida, Bali',
  },
  transcript: {
    text: 'we took the boat to noosa peneeda and walked down to kelingking',
    words: [], language: 'en', pass: 1, vocabulary: [],
  },
  transcriptPass1: null,
  onScreenText: [{ text: 'Angel Billabong', atSeconds: 8, frameRef: 'f.jpg' }],
  ocrFailedFrames: 0, ocrProvider: 'gemini', audioSource: 'video', skippedAsrReason: null,
  biasVerdict: null, corroborationTerms: ['balitravel'],
  durationSeconds: 30, imageRefs: [], createdAt: '2026-01-01T00:00:00Z',
} as unknown as EvidenceBundle

const mention = (over: Partial<Mention>): Mention => ({
  rawName: 'X', sourceQuote: 'X', sourceType: 'caption',
  sourceSeconds: null, asrConfidence: null, ...over,
})

// --- the guard --------------------------------------------------------------
console.log('\n\x1b[1mQUOTE VERIFICATION\x1b[0m')

check('keeps a mention whose quote is really in the caption',
  verifyMentions([mention({ rawName: 'Kelingking Beach', sourceQuote: 'Kelingking Beach' })], bundle).kept.length === 1)

// The whole point of the design: a fabricated place cannot survive this.
const invented = verifyMentions([mention({
  rawName: 'Warung Sunset Paradise',
  sourceQuote: 'the best warung on the island is Warung Sunset Paradise',
})], bundle)
check('DROPS an invented place with an invented quote',
  invented.kept.length === 0 && invented.rejected.length === 1,
  invented.rejected[0]?.reason ?? '')

// A model can quote an honest sentence and still attach a name the sentence
// never contained — this is the subtler fabrication, and the costlier one.
const smuggled = verifyMentions([mention({
  rawName: 'Crystal Bay',
  sourceQuote: 'Nusa Penida day trip!',
})], bundle)
check('DROPS a name smuggled onto a genuine quote',
  smuggled.kept.length === 0, smuggled.rejected[0]?.reason ?? '')

// Attributing a caption name to the transcript would invent a MOMENT, and the
// UI would then show a frame and an audio clip as proof of something unsaid.
const misattributed = verifyMentions([mention({
  rawName: 'Kelingking Beach',
  sourceQuote: 'Kelingking Beach',
  sourceType: 'transcript',
  sourceSeconds: 12,
})], bundle)
check('DROPS a caption quote misattributed to the transcript',
  misattributed.kept.length === 0, misattributed.rejected[0]?.reason ?? '')

check('accepts a genuine transcript quote',
  verifyMentions([mention({
    rawName: 'noosa peneeda', sourceQuote: 'boat to noosa peneeda',
    sourceType: 'transcript', sourceSeconds: 4,
  })], bundle).kept.length === 1)

check('accepts an on-screen-text quote',
  verifyMentions([mention({
    rawName: 'Angel Billabong', sourceQuote: 'Angel Billabong',
    sourceType: 'onScreenText', sourceSeconds: 8,
  })], bundle).kept.length === 1)

// Normalisation must forgive FORMATTING without forgiving content: the caption
// has a curly apostrophe, and an honest quote typed with a straight one is
// still honest.
check('a curly/straight apostrophe difference does not reject an honest quote',
  verifyQuotes([{ sourceQuote: "Don't miss Kelingking Beach", sourceType: 'caption' as const }], bundle).kept.length === 1)
check('normalisation only touches formatting, never letters',
  normalizeForMatch('  Café—“Test”  ') === 'café-"test"',
  normalizeForMatch('  Café—“Test”  '))

check('rejects a quote claiming an empty source',
  verifyQuotes([{ sourceQuote: 'anything', sourceType: 'onScreenText' as const }],
    { ...bundle, onScreenText: [] } as EvidenceBundle).rejected.length === 1)

// --- clustering -------------------------------------------------------------
console.log('\n\x1b[1mRECONCILIATION\x1b[0m')

check('matches ASR mangling to the caption spelling (phonetic)',
  samePlace('noosa peneeda', 'Nusa Penida'))
check('matches a lowercase hashtag to spaced speech',
  samePlace('goldengai', 'Golden Gai'))
check('does NOT merge two genuinely different places',
  !samePlace('Kelingking Beach', 'Diamond Beach'))
check('does NOT merge on a short phonetic collision',
  !samePlace('Ebisu', 'Ubud'))

// The token-prefix rule earns its keep on the first pair and must not overreach
// on the second: a shared trailing word is not identity, or every beach in a
// capture folds into whichever was named first.
check('merges a bare name with its fuller form',
  samePlace('Mandarake', 'Mandarake Shibuya') && samePlace('Nusa Penida', 'Nusa Penida Bali'))
check('does NOT merge on a shared trailing word',
  !samePlace('Beach', 'Kelingking Beach') && !samePlace('Coffee', 'Janai Coffee'))
check('does NOT merge two places sharing a leading word',
  !samePlace('Kelingking Beach', 'Kelingking Viewpoint'))

const clusters = clusterMentions([
  mention({ rawName: 'noosa peneeda', sourceType: 'transcript', sourceSeconds: 4 }),
  mention({ rawName: 'Nusa Penida', sourceType: 'caption' }),
  mention({ rawName: 'Angel Billabong', sourceType: 'onScreenText', sourceSeconds: 8 }),
])
check('three mentions collapse to two places', clusters.length === 2,
  clusters.map((c) => c.name).join(' | '))

const penida = clusters.find((c) => c.mentions.length === 2)!
check('canonical spelling comes from the caption, not the audio',
  penida.name === 'Nusa Penida', `got "${penida.name}"`)
check('cluster keeps every witness as an audit trail', penida.mentions.length === 2)
check('cluster records which source types named it',
  penida.sources.includes('caption') && penida.sources.includes('transcript'),
  penida.sources.join(', '))
check('cluster keeps the earliest timestamp for the frame/clip evidence',
  penida.firstSeconds === 4, String(penida.firstSeconds))

// A hashtag is caption-sourced but is not prose. Observed live: "#goldengai"
// outranked the voiceover's "Golden Gai" on source alone, handing the geocoder
// a string Google cannot resolve and turning a real bar district into an
// unverified pin.
const tag = clusterMentions([
  mention({ rawName: 'goldengai', sourceType: 'caption' }),
  mention({ rawName: 'Golden Gai', sourceType: 'transcript', sourceSeconds: 5 }),
])
check('a spaced, capitalised name beats a squashed hashtag',
  tag[0]?.name === 'Golden Gai', tag[0]?.name ?? '')
check('...and they are still one place, not two', tag.length === 1)

// Longer names geocode better: "Mandarake Shibuya" resolves, "Mandarake" is ambiguous.
const shibuya = clusterMentions([
  mention({ rawName: 'Mandarake', sourceType: 'caption' }),
  mention({ rawName: 'Mandarake Shibuya', sourceType: 'caption' }),
])
check('prefers the fuller name within the same source rank',
  shibuya[0]?.name === 'Mandarake Shibuya', shibuya[0]?.name ?? '')

const tips = [
  { aboutPlace: 'noosa peneeda', text: 'go early' },
  { aboutPlace: null, text: 'bring cash' },
]
const { byCluster, unattached } = attachToClusters(tips, clusters)
check('attaches a tip via the mangled name it was written against',
  byCluster.get(penida)?.length === 1)
check('keeps place-less tips separate rather than guessing', unattached.length === 1)

console.log(failures === 0 ? '\n\x1b[32mall good\x1b[0m' : `\n\x1b[31m${failures} failed\x1b[0m`)
process.exit(failures === 0 ? 0 : 1)
