/**
 * Offline tests for Stage B1 — the interpretation call and everything code does
 * around it: the per-source split, the timestamps recovered from ASR word
 * timings, and the refusal to carry on quietly after an unusable reply.
 *
 * The model is a function here, not a network call, so there are no keys, no
 * quota and no flakiness — and the interesting cases (a model claiming the
 * wrong source, a model answering in prose) can be reproduced on demand rather
 * than waited for.
 *
 *   npm run smoke:interpret -w @reel/server
 */
import type { EvidenceBundle, TranscriptWord } from '@reel/shared'
import { ExtractionOutput } from '@reel/shared'
import {
  buildPrompt, interpret, locateInTranscript, locateOnScreen, ModelReplyError,
  type ModelCall, type ModelRequest,
} from './extract/interpret.ts'
import { locateMention } from './extract/interpret.ts'
import { verifyMentions } from './extract/verify.ts'

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`)
  if (!ok) failures++
}

// --- evidence ---------------------------------------------------------------

/** Word timings a real Groq/Whisper reply would carry, punctuation included. */
const words: TranscriptWord[] = [
  ['we', 0], ['took', 300], ['the', 600], ['boat', 900], ['to', 1300],
  ['noosa', 1600], ['peneeda,', 2100], ['and', 2800], ['walked', 3100],
  ['down', 3500], ['to', 3800], ['kelingking', 4000],
].map(([word, startMs]) => ({
  word: word as string,
  startMs: startMs as number,
  endMs: (startMs as number) + 250,
  confidence: word === 'peneeda,' ? 0.41 : 0.92,
}))

const bundle = {
  captureId: 't', platform: 'instagram', url: 'u', author: null, postedAt: null,
  caption: {
    text: 'Nusa Penida day trip! Don’t miss Kelingking Beach — boat is 200k IDR.',
    hashtags: ['balitravel'],
    locationTag: 'Nusa Penida, Bali',
  },
  transcript: {
    text: 'we took the boat to noosa peneeda, and walked down to kelingking',
    words, language: 'en', pass: 1, vocabulary: [],
  },
  transcriptPass1: null,
  onScreenText: [
    { text: 'Angel Billabong', atSeconds: 8, frameRef: 'f8.jpg' },
    { text: 'Crystal Bay sunset', atSeconds: 19.5, frameRef: 'f19.jpg' },
  ],
  ocrFailedFrames: 0, ocrProvider: 'gemini', audioSource: 'video', skippedAsrReason: null,
  biasVerdict: null, corroborationTerms: ['balitravel'],
  durationSeconds: 30, imageRefs: [], createdAt: '2026-01-01T00:00:00Z',
} as unknown as EvidenceBundle

// --- the fake model ---------------------------------------------------------

/** Records what each source was asked, and replies from a per-source script. */
function fakeModel(replies: Partial<Record<string, string>>, fallback = '{}') {
  const calls: ModelRequest[] = []
  const call: ModelCall = async (req) => {
    calls.push(req)
    const source = req.label.replace('interpret ', '')
    return replies[source] ?? fallback
  }
  return { call, calls, sources: () => calls.map((c) => c.label.replace('interpret ', '')) }
}

const json = (o: unknown) => JSON.stringify(o)

// --- per-source attribution -------------------------------------------------
console.log('\n\x1b[1mPER-SOURCE ATTRIBUTION\x1b[0m')

// The model is told, loudly and in several ways, which source it is reading —
// and it is still not trusted with it. Here it claims every item came from the
// transcript, with timings to match.
const liar = fakeModel({
  caption: json({
    mentions: [{
      rawName: 'Kelingking Beach',
      sourceQuote: 'Don’t miss Kelingking Beach',
      sourceType: 'transcript',
      sourceSeconds: 12.5,
      asrConfidence: 0.99,
    }],
    tips: [{
      kind: 'cost', text: 'the boat costs 200k IDR',
      sourceQuote: 'boat is 200k IDR', sourceType: 'transcript', sourceSeconds: 3,
      aboutPlace: 'Kelingking Beach',
    }],
    facts: [{
      label: 'boat price', value: '200k IDR',
      sourceQuote: 'boat is 200k IDR', sourceType: 'onScreenText', sourceSeconds: 8,
    }],
    destination: 'Bali',
  }),
  onScreenText: json({ mentions: [{ rawName: 'Angel Billabong', sourceQuote: 'Angel Billabong', sourceType: 'caption' }] }),
  transcript: json({ mentions: [{ rawName: 'noosa peneeda', sourceQuote: 'boat to noosa peneeda', sourceType: 'caption' }] }),
})

const out = await interpret(bundle, 'travel', undefined, liar.call)

check('runs the model once per non-empty source, not once over the bundle',
  liar.calls.length === 3, liar.sources().join(', '))
check('each call carries exactly one source of text',
  liar.calls.every((c) => {
    const body = c.user.split('--- SOURCE TEXT (the only text you may quote) ---')[1] ?? ''
    const others = ['Kelingking Beach', 'noosa peneeda', 'Angel Billabong']
      .filter((needle) => body.includes(needle))
    return others.length === 1
  }))

const caption = out.mentions.find((m) => m.rawName === 'Kelingking Beach')
check('a caption item claiming to be from the transcript is stamped caption',
  caption?.sourceType === 'caption', `got ${caption?.sourceType}`)
check('the timestamp the model invented for it is discarded',
  caption?.sourceSeconds === null, String(caption?.sourceSeconds))
check('the ASR confidence the model invented for it is discarded',
  caption?.asrConfidence === null, String(caption?.asrConfidence))
check('tips are stamped from the source they were read in, not the one claimed',
  out.tips[0]?.sourceType === 'caption' && out.tips[0]?.sourceSeconds === null)
check('facts are stamped from the source they were read in, not the one claimed',
  out.facts[0]?.sourceType === 'caption' && out.facts[0]?.sourceSeconds === null)
check('an on-screen item claiming to be the caption is stamped onScreenText',
  out.mentions.find((m) => m.rawName === 'Angel Billabong')?.sourceType === 'onScreenText')
check('a transcript item claiming to be the caption is stamped transcript',
  out.mentions.find((m) => m.rawName === 'noosa peneeda')?.sourceType === 'transcript')

// The stamped source is what B2 checks against, so a mislabelled item now dies
// in the guard instead of reaching the map with a fabricated timestamp.
check('the stamped sourceType is what makes B2 able to reject a misattribution',
  verifyMentions(out.mentions, bundle).kept.length === 3,
  verifyMentions(out.mentions, bundle).rejected.map((r) => r.reason).join('; '))

// --- timestamps -------------------------------------------------------------
console.log('\n\x1b[1mTIMESTAMPS FROM WORD TIMINGS\x1b[0m')

const heard = out.mentions.find((m) => m.rawName === 'noosa peneeda')
// Timed to the NAME, not the quote. The quote is "boat to noosa peneeda" and
// starts at 0.9s ("boat"); the name starts at 1.6s. A clip centred on 0.9 would
// play "we took the boat" and end before the place was ever said.
check('a mention is timed to where its NAME is spoken, not where its quote starts',
  heard?.sourceSeconds === 1.6, `got ${heard?.sourceSeconds} (expected 1.6, the "noosa" token)`)
check('asrConfidence is the weakest word of the NAME',
  heard?.asrConfidence === 0.41, String(heard?.asrConfidence))

// The real quote that exposed this: the name sits at the END of a long quote.
const long: TranscriptWord[] = [
  'right', 'here', 'in', 'the', 'neighborhood', "we're", 'in,', 'ebisu,', 'is', 'janai', 'coffee.',
].map((word, i) => ({ word, startMs: 30000 + i * 400, endMs: 30000 + i * 400 + 300, confidence: 0.9 }))
check('a name at the end of a long quote is timed to the name, not the quote start',
  locateMention(long, "Right here in the neighborhood we're in, Ebisu, is Janai Coffee", 'Janai Coffee').seconds === 33.6,
  String(locateMention(long, "Right here in the neighborhood we're in, Ebisu, is Janai Coffee", 'Janai Coffee').seconds))

// Said twice: the cited occurrence is the one inside the quote.
const twice: TranscriptWord[] = [
  'ebisu', 'is', 'great', 'later', 'we', 'went', 'back', 'to', 'ebisu', 'for', 'dinner',
].map((word, i) => ({ word, startMs: i * 1000, endMs: i * 1000 + 500, confidence: 0.9 }))
check('a name said twice is timed to the occurrence inside its quote',
  locateMention(twice, 'went back to ebisu for dinner', 'ebisu').seconds === 8,
  String(locateMention(twice, 'went back to ebisu for dinner', 'ebisu').seconds))

check('falls back to the quote start when the name is not in the audio as given',
  locateMention(words, 'boat to noosa peneeda', 'Nusa Penida').seconds === 0.9,
  String(locateMention(words, 'boat to noosa peneeda', 'Nusa Penida').seconds))

// ASR tokenising the FRONT of a quote differently used to lose it entirely,
// because a partial match had to start at the quote's first word.
check('a quote whose opening words ASR split differently is still located',
  locateInTranscript(words, "we've took the boat to noosa").seconds === 0.3,
  String(locateInTranscript(words, "we've took the boat to noosa").seconds))

check('locates a quote that starts mid-sentence',
  locateInTranscript(words, 'walked down to kelingking').seconds === 3.1,
  String(locateInTranscript(words, 'walked down to kelingking').seconds))
check('punctuation in the ASR token does not break the match',
  locateInTranscript(words, 'noosa peneeda').seconds === 1.6)
check('a quote that is not in the audio gets no timestamp rather than a wrong one',
  locateInTranscript(words, 'crystal bay at sunset').seconds === null)
check('a transcript with no word timings yields null, not a guess',
  locateInTranscript([], 'boat to noosa peneeda').seconds === null)

check('on-screen sourceSeconds is the frame the text was read off',
  out.mentions.find((m) => m.rawName === 'Angel Billabong')?.sourceSeconds === 8)
check('picks the right frame when several carry text',
  locateOnScreen(bundle.onScreenText, 'Crystal Bay sunset') === 19.5)
check('an on-screen quote matching no single frame gets no timestamp',
  locateOnScreen(bundle.onScreenText, 'Angel Billabong Crystal Bay sunset') === null)

// --- empty sources ----------------------------------------------------------
console.log('\n\x1b[1mEMPTY SOURCES\x1b[0m')

const silent = fakeModel({}, json({ mentions: [{ rawName: 'Angel Billabong', sourceQuote: 'Angel Billabong' }] }))
await interpret(
  { ...bundle, transcript: null, onScreenText: [] } as EvidenceBundle,
  'travel', undefined, silent.call,
)
check('a capture with no speech and no overlay calls the model once, for the caption',
  silent.calls.length === 1 && silent.sources()[0] === 'caption', silent.sources().join(', '))

const mute = fakeModel({}, json({ mentions: [] }))
const empty = await interpret(
  {
    ...bundle,
    caption: { text: '', hashtags: [], locationTag: null },
    transcript: null,
    onScreenText: [],
  } as unknown as EvidenceBundle,
  'travel', undefined, mute.call,
)
check('a bundle with nothing in it calls the model zero times', mute.calls.length === 0)
check('and still returns a valid, empty ExtractionOutput',
  ExtractionOutput.safeParse(empty).success && empty.mentions.length === 0)

// --- unusable replies -------------------------------------------------------
console.log('\n\x1b[1mUNUSABLE REPLIES FAIL LOUDLY\x1b[0m')

async function throws(label: string, replies: Partial<Record<string, string>>, expect = 'caption') {
  try {
    await interpret(bundle, 'travel', undefined, fakeModel(replies).call)
    check(label, false, 'returned normally')
  } catch (err) {
    const ok = err instanceof ModelReplyError && err.sourceType === expect
    check(label, ok, err instanceof Error ? err.message.split('\n')[0] : String(err))
  }
}

// A refusal or an apology is the common failure, and the dangerous one: it looks
// exactly like a reel that mentioned nowhere.
await throws('prose instead of JSON throws rather than returning nothing',
  { caption: 'I am sorry, I cannot help with that request.' })
await throws('an empty reply throws', { caption: '   ' })
await throws('a truncated JSON reply throws', { caption: '{"mentions": [{"rawName": "Kel' })
await throws('a reply of the wrong shape throws', { caption: json({ mentions: 'Kelingking Beach' }) })
await throws('a failure on a later source is not hidden by an earlier success',
  { caption: json({ mentions: [] }), onScreenText: 'no text found', transcript: json({ mentions: [] }) },
  'onScreenText')

// Tolerances that are formatting, not substance.
const fenced = await interpret(bundle, 'travel', undefined, fakeModel({
  caption: '```json\n' + json({ mentions: [{ rawName: 'Kelingking Beach', sourceQuote: 'Don’t miss Kelingking Beach' }] }) + '\n```',
}, json({})).call)
check('a fenced code block is tolerated — formatting, not fabrication',
  fenced.mentions.length === 1)

const sparse = await interpret(bundle, 'travel', undefined, fakeModel({}, json({ mentions: null, tips: null, facts: null })).call)
check('null arrays are read as empty, not as a crash', sparse.mentions.length === 0)

const oddKind = await interpret(bundle, 'travel', undefined, fakeModel({
  caption: json({ tips: [{ kind: 'advice', text: 'go early', sourceQuote: 'Nusa Penida day trip!' }] }),
}, json({})).call)
check('an out-of-vocabulary tip kind is coerced, not thrown away with its quote',
  oddKind.tips.length === 1 && oddKind.tips[0]?.kind === 'do', oddKind.tips[0]?.kind ?? 'none')

// --- output contract --------------------------------------------------------
console.log('\n\x1b[1mOUTPUT CONTRACT\x1b[0m')

const parsed = ExtractionOutput.safeParse(out)
check('output validates against the shared ExtractionOutput schema', parsed.success,
  parsed.success ? '' : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
check('every item carries a quote and a source type',
  [...out.mentions, ...out.tips, ...out.facts].every((i) => i.sourceQuote.length > 0 && i.sourceType.length > 0))
check('items with an empty name or quote are dropped before they reach the schema',
  (await interpret(bundle, 'travel', undefined, fakeModel({
    caption: json({
      mentions: [
        { rawName: '', sourceQuote: 'Nusa Penida day trip!' },
        { rawName: 'Kelingking Beach', sourceQuote: '   ' },
        { rawName: 'Kelingking Beach', sourceQuote: 'Don’t miss Kelingking Beach' },
      ],
    }),
  }, json({})).call)).mentions.length === 1)
check('the same item said twice in one source is kept once',
  (await interpret(bundle, 'travel', undefined, fakeModel({
    caption: json({
      mentions: [
        { rawName: 'Kelingking Beach', sourceQuote: 'Don’t miss Kelingking Beach' },
        { rawName: 'Kelingking  Beach ', sourceQuote: 'Don’t miss Kelingking Beach' },
      ],
    }),
  }, json({})).call)).mentions.length === 1)

// The one field with no quote to check, so it is checked against the text itself.
check('destination is kept when the source text actually contains it',
  out.destination === 'Bali', String(out.destination))
check('a destination the text never states is dropped rather than scoping geocoding',
  (await interpret(bundle, 'travel', undefined,
    fakeModel({}, json({ mentions: [], destination: 'Thailand' })).call)).destination === null)

// --- the prompt -------------------------------------------------------------
console.log('\n\x1b[1mPROMPT\x1b[0m')

const prompt = buildPrompt('transcript', 'travel', bundle.transcript!.text)
check('the prompt tells the model which source it is reading',
  prompt.user.includes('THIS SOURCE IS: transcript'))
check('the prompt forbids correcting ASR spelling, which would break phonetic matching',
  prompt.system.includes('noosa peneeda'))
check('the prompt tells the model its timestamps and source labels are discarded',
  prompt.system.includes('Do not emit timestamps'))
check('the prompt carries the profile it was asked for',
  buildPrompt('caption', 'recipe', 'x').user.includes('ingredients'))
check('long sources are truncated, and a truncated source can only be quoted from',
  buildPrompt('caption', 'travel', 'x'.repeat(20_000)).user.includes('x'.repeat(12_000))
  && !buildPrompt('caption', 'travel', 'x'.repeat(20_000)).user.includes('x'.repeat(12_001)))

console.log(failures === 0 ? '\n\x1b[32mall good\x1b[0m' : `\n\x1b[31m${failures} failed\x1b[0m`)
process.exit(failures === 0 ? 0 : 1)
