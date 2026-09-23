import { readFile } from 'node:fs/promises'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { migrate } from './db/index.ts'
import {
  createCapture, getCapture, listCaptures, listMapPlaces, listNeedsCheck,
} from './db/store.ts'
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
  })
}

export { app }

if (import.meta.filename === process.argv[1]) await startServer()
