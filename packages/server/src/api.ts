import { readFile } from 'node:fs/promises'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { migrate } from './db/index.ts'
import {
  applyCorrection, confirmPlace, createCapture, deleteCapture, dismissPlace,
  getCapture, getPlace, listCaptures, listMapPlaces, listNeedsCheck,
} from './db/store.ts'
import { geocode } from './extract/geocode.ts'
import { kindFromTypes } from './extract/index.ts'
import type { CorrectPlaceRequest } from '@reel/shared'
import { enqueue, queueDepth } from './jobs.ts'
import { captureIdFor } from './lib/workdir.ts'
import { resolverFor } from './resolvers/index.ts'
import { clipAt, frameAt } from './perception/evidence-media.ts'

/**
 * The HTTP surface the app talks to.
 *
 * Processing a reel takes 30-60s and phones kill background work, so sharing a
 * link only ENQUEUES it: the request returns immediately with an id, and the
 * app polls. Nothing the user sees depends on their phone staying awake.
 */
const app = new Hono()

// The app runs on a device, in a simulator and in a browser during development,
// so its origin is never predictable. This is a personal server on a LAN or
// behind ngrok; when it becomes multi-user it needs auth, and then this needs
// tightening to match.
app.use('/*', cors())

app.get('/health', async (c) => c.json({ ok: true, queued: queueDepth() }))

/** Share a link. Returns straight away; the work happens behind it. */
app.post('/captures', async (c) => {
  type Body = { url?: string; profile?: string }
  const body: Body = await c.req.json<Body>().catch(() => ({}))
  const url = body.url?.trim()
  if (!url) return c.json({ error: 'url is required' }, 400)

  try {
    resolverFor(url)
  } catch {
    return c.json({
      error: 'unsupported link',
      detail: 'Supported: Instagram posts and reels, YouTube, YouTube Shorts, TikTok.',
    }, 400)
  }

  const id = captureIdFor(url)
  await createCapture({ id, url, profile: body.profile })
  enqueue(id, url, body.profile)

  // 202: accepted, not finished. The app polls GET /captures/:id.
  return c.json({ id, status: 'queued' }, 202)
})

app.get('/captures', async (c) => {
  const limit = Number(c.req.query('limit') ?? 50)
  return c.json({ captures: await listCaptures(Math.min(limit, 200)) })
})

app.get('/captures/:id', async (c) => {
  const found = await getCapture(c.req.param('id'))
  if (!found) return c.json({ error: 'not found' }, 404)
  return c.json(found)
})

app.delete('/captures/:id', async (c) => {
  const gone = await deleteCapture(c.req.param('id'))
  return gone ? c.body(null, 204) : c.json({ error: 'not found' }, 404)
})

// --- your verdicts ---------------------------------------------------------
// The tray is only useful if you can act on it. Each of these records that a
// human made the call, which is a stronger check than any match grade.

app.post('/places/:id/confirm', async (c) => {
  const place = await confirmPlace(c.req.param('id'))
  return place ? c.json(place) : c.json({ error: 'not found' }, 404)
})

app.post('/places/:id/dismiss', async (c) => {
  const place = await dismissPlace(c.req.param('id'))
  return place ? c.json(place) : c.json({ error: 'not found' }, 404)
})

/**
 * You know the right name. It still goes through Google and the same match
 * grading as the pipeline: a typo in your correction should not become a
 * confident pin any more than a typo in the reel should.
 */
app.post('/places/:id/correct', async (c) => {
  const id = c.req.param('id')
  const body: Partial<CorrectPlaceRequest> = await c.req.json<CorrectPlaceRequest>().catch(() => ({}))
  const name = body.name?.trim()
  if (!name) return c.json({ error: 'name is required' }, 400)

  const place = await getPlace(id)
  if (!place) return c.json({ error: 'not found' }, 404)

  let hit
  try {
    hit = await geocode(name, { destination: place.destination })
  } catch (err) {
    // The lookup never happened — that says nothing about whether the place exists.
    return c.json({ error: 'geocoding unavailable', detail: (err as Error).message }, 503)
  }
  if (!hit) {
    return c.json({ error: 'not found on Google', detail: `Nothing matched "${name}". Try the name as it appears on Google Maps.` }, 422)
  }

  const strong = hit.match === 'exact' || hit.match === 'strong'
  const updated = await applyCorrection(id, {
    name,
    kind: kindFromTypes(hit.types),
    // A loose match on your own correction still comes back to you to confirm.
    status: strong ? 'confirmed' : 'needs_check',
    confidence: strong ? 'high' : 'low',
    googlePlaceId: hit.placeId,
    lat: hit.lat,
    lng: hit.lng,
    canonicalName: hit.canonicalName,
    address: hit.address,
  })
  return c.json(updated)
})

/** The tray: everything the pipeline would not vouch for on its own. */
app.get('/needs-check', async (c) => c.json({ places: await listNeedsCheck() }))

/** Confirmed pins across every capture, one per real place. */
app.get('/map', async (c) => c.json({ places: await listMapPlaces() }))

// --- evidence --------------------------------------------------------------
// The point of these two: a name you are unsure of should be resolvable without
// reopening Instagram and scrubbing a reel.

app.get('/captures/:id/frame', async (c) => {
  const at = Number(c.req.query('at') ?? 0)
  const file = await frameAt(c.req.param('id'), Number.isFinite(at) ? at : 0)
  return file ? sendFile(file, 'image/jpeg') : c.json({ error: 'no frame' }, 404)
})

app.get('/captures/:id/clip', async (c) => {
  const at = Number(c.req.query('at') ?? 0)
  const file = await clipAt(c.req.param('id'), Number.isFinite(at) ? at : 0)
  // 404 is the honest answer for a carousel or a music-track reel: there is no
  // audio to play, and a silent file would look like a bug.
  return file ? sendFile(file, 'audio/mp4') : c.json({ error: 'no audio for this capture' }, 404)
})

/**
 * Reads the whole file and sends it.
 *
 * A Node fs stream is NOT a web ReadableStream, and casting one into a Response
 * body is a lie that node-server does not always survive — it served a frame
 * and then killed the process on the next request. These files are small by
 * construction (a downscaled frame, a three-second clip), so buffering is both
 * correct and cheap; if long-form audio is ever served, convert properly with
 * `Readable.toWeb` rather than reinstating the cast.
 */
async function sendFile(file: string, type: string): Promise<Response> {
  const bytes = await readFile(file)
  return new Response(new Uint8Array(bytes), {
    headers: {
      'content-type': type,
      'content-length': String(bytes.byteLength),
      // Evidence for a given second never changes once cut.
      'cache-control': 'public, max-age=31536000, immutable',
    },
  })
}

export async function startServer(port = Number(process.env.PORT ?? 3000)) {
  await migrate()
  serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, (info) => {
    console.log(`reel-trip api on http://localhost:${info.port}`)
    console.log('  POST /captures {url}      share a link')
    console.log('  GET  /captures/:id        status + result')
    console.log('  GET  /needs-check         the tray')
    console.log('  GET  /map                 confirmed pins')
    console.log('  POST /places/:id/confirm | dismiss | correct {name}')
  })
}

export { app }

if (import.meta.filename === process.argv[1]) await startServer()
