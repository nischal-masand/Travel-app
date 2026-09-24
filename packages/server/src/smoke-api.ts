/**
 * The HTTP contract the app is built against, exercised in-process.
 *
 * Hono's app.request() runs a request through the real routes with no socket,
 * and WORK_DIR points the database at a throwaway folder — so this touches no
 * network, no API keys and none of your real captures.
 *
 *   npm run smoke:api -w @reel/server
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type {
  ApiCaptureDetail, ApiCaptureSummary, ApiMapPlace, ApiPlace, ApiTrayItem,
  CaptureResult, EvidenceBundle,
} from '@reel/shared'

// Must be set before the db module is imported: it resolves its file on load.
const dir = mkdtempSync(path.join(tmpdir(), 'reel-api-'))
process.env.WORK_DIR = dir
delete process.env.DATABASE_URL

const { migrate } = await import('./db/index.ts')
const { saveResult } = await import('./db/store.ts')
const { app } = await import('./api.ts')

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`)
  if (!ok) failures++
}
const section = (t: string) => console.log(`\n\x1b[1m${t}\x1b[0m`)

const call = async (method: string, url: string, body?: unknown) => {
  const res = await app.request(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}

await migrate()

const CAPTURE = 'cap000000001'
const bundle = {
  captureId: CAPTURE, platform: 'instagram', url: 'https://www.instagram.com/reel/TEST/',
  author: 'johnmarcoasks', postedAt: null,
  caption: { text: 'Nerd-core bars in Tokyo', hashtags: ['goldengai'], locationTag: null },
  transcript: null, transcriptPass1: null, onScreenText: [],
  ocrFailedFrames: 0, ocrProvider: 'gemini', audioSource: 'video', skippedAsrReason: null,
  biasVerdict: null, corroborationTerms: [], durationSeconds: 66, imageRefs: [],
  createdAt: new Date().toISOString(),
} as unknown as EvidenceBundle

const mention = (rawName: string, sourceSeconds: number | null, sourceType = 'transcript') => ({
  rawName, sourceQuote: rawName, sourceType, sourceSeconds, asrConfidence: null,
})

const result = {
  captureId: CAPTURE, profile: 'travel', destination: 'Tokyo',
  places: [
    {
      id: 'place-janai', name: 'Janai Coffee', kind: 'cafe', whyGo: null, timeNeeded: null, bestTime: null,
      mentions: [mention('Janai Coffee', 33.4), mention('JANAI COFFEE', 44.1, 'onScreenText')],
      facts: [], tips: [{
        kind: 'hack', text: 'secret door', sourceQuote: 'secret door',
        sourceType: 'transcript', sourceSeconds: 40, aboutPlace: 'Janai Coffee',
      }],
      status: 'confirmed', confidence: 'high', placeId: 'ChIJjanai',
      lat: 35.6455, lng: 139.7073, canonicalName: 'JANAI COFFEE', address: 'Ebisu, Tokyo',
    },
    {
      id: 'place-kaiju', name: 'Kaiju Sakeba', kind: 'other', whyGo: null, timeNeeded: null, bestTime: null,
      mentions: [mention('Kaiju Sakeba', 21.4)], facts: [], tips: [],
      status: 'needs_check', confidence: 'low', placeId: null,
      lat: null, lng: null, canonicalName: null, address: null,
    },
  ],
  generalTips: [], generalFacts: [], rejected: [{ reason: 'quote not found in caption', item: {} }],
} as unknown as CaptureResult

await saveResult(bundle, result)

section('INBOX')
const inbox = await call('GET', '/captures')
const row = (inbox.json.captures as ApiCaptureSummary[])[0]
check('lists the capture', row?.id === CAPTURE)
check('counts its places', row?.placeCount === 2, String(row?.placeCount))
check('counts what needs checking', row?.needsCheckCount === 1, String(row?.needsCheckCount))
check('carries the rejection count', row?.rejectedCount === 1)

section('CAPTURE DETAIL')
const detail = (await call('GET', `/captures/${CAPTURE}`)).json as ApiCaptureDetail
const janai = detail.places.find((p) => p.id === 'place-janai')
check('returns places with their audit trail', janai?.mentions.length === 2)
check('exposes Google\'s id as googlePlaceId, not placeId', janai?.googlePlaceId === 'ChIJjanai')
check('attaches tips to their place', janai?.tips[0]?.kind === 'hack')
check('mentions carry the second they were said', janai?.mentions.some((m) => m.sourceSeconds === 33.4) === true)
check('an unknown capture is a 404', (await call('GET', '/captures/nope')).status === 404)

section('THE TRAY')
const tray = (await call('GET', '/needs-check')).json.places as ApiTrayItem[]
check('holds only unverified places', tray.length === 1 && tray[0]?.id === 'place-kaiju')
check('says which reel it came from', tray[0]?.capture.author === 'johnmarcoasks')
check('carries mentions for the evidence UI', tray[0]?.mentions[0]?.sourceSeconds === 21.4)

section('VERDICTS')
const confirmed = (await call('POST', '/places/place-kaiju/confirm')).json as ApiPlace
check('confirm marks it confirmed', confirmed.status === 'confirmed')
check('confirm records that a human decided', confirmed.reviewedBy === 'user')
check('a human confirmation is high confidence', confirmed.confidence === 'high')
check('the tray empties once you decide',
  ((await call('GET', '/needs-check')).json.places as ApiTrayItem[]).length === 0)

const map = (await call('GET', '/map')).json.places as ApiMapPlace[]
check('the map shows confirmed places that have coordinates', map.some((p) => p.id === 'place-janai'))
check('a place confirmed without coordinates stays off the map',
  !map.some((p) => p.id === 'place-kaiju'))

const dismissed = (await call('POST', '/places/place-janai/dismiss')).json as ApiPlace
check('dismiss marks it dismissed, not deleted', dismissed.status === 'dismissed')
check('a dismissed place leaves the map',
  !((await call('GET', '/map')).json.places as ApiMapPlace[]).some((p) => p.id === 'place-janai'))
const afterDismiss = ((await call('GET', '/captures')).json.captures as ApiCaptureSummary[])[0]
check('dismissed places drop out of the inbox count',
  afterDismiss?.placeCount === 1, `placeCount=${afterDismiss?.placeCount} needsCheck=${afterDismiss?.needsCheckCount}`)

// Re-running a reel after a pipeline fix must not undo your decisions.
await saveResult(bundle, result)
const rerun = (await call('GET', `/captures/${CAPTURE}`)).json as ApiCaptureDetail
check('a re-run keeps a dismissal', rerun.places.find((p) => p.id === 'place-janai')?.status === 'dismissed')
check('a re-run keeps a confirmation', rerun.places.find((p) => p.id === 'place-kaiju')?.status === 'confirmed')

check('verdict on an unknown place is a 404', (await call('POST', '/places/nope/confirm')).status === 404)
check('a correction needs a name', (await call('POST', '/places/place-kaiju/correct', {})).status === 400)

section('INPUT VALIDATION')
check('sharing with no url is a 400', (await call('POST', '/captures', {})).status === 400)
const bad = await call('POST', '/captures', { url: 'https://example.com/x' })
check('an unsupported link is a 400 that says what IS supported',
  bad.status === 400 && /Instagram/.test(bad.json.detail), bad.json.detail)

section('DELETE')
check('deleting a capture returns 204', (await call('DELETE', `/captures/${CAPTURE}`)).status === 204)
check('...and it is gone', (await call('GET', `/captures/${CAPTURE}`)).status === 404)
check('deleting again is a 404', (await call('DELETE', `/captures/${CAPTURE}`)).status === 404)

// Windows keeps the SQLite file locked while the client is open. It is a temp
// folder, so a failed cleanup is the OS's problem, not a test failure.
try { rmSync(dir, { recursive: true, force: true }) } catch { /* locked on Windows */ }
console.log(failures === 0 ? '\n\x1b[32mall good\x1b[0m' : `\n\x1b[31m${failures} failed\x1b[0m`)
process.exit(failures === 0 ? 0 : 1)
