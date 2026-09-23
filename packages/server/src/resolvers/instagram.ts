import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { env } from '../lib/env.ts'
import { withRetry } from '../lib/retry.ts'
import { parseHashtags, type ResolvedMedia, type Resolver } from './types.ts'

/**
 * Instagram has no legitimate third-party API, so this goes through a resolver
 * actor on Apify: we hand it a reel URL, it hands back the media URL, the
 * caption and any carousel slides. Your own Instagram account is never involved.
 *
 * Actor output shapes differ between providers and drift over time, so the
 * normaliser below is deliberately tolerant. When one breaks, swapping provider
 * should mean editing `pickItem` and nothing else.
 */

interface ApifyItem {
  type?: string
  caption?: string
  videoUrl?: string
  displayUrl?: string
  images?: string[]
  ownerUsername?: string
  ownerFullName?: string
  timestamp?: string
  locationName?: string
  childPosts?: ApifyItem[]
  audioUrl?: string
  musicInfo?: { uses_original_audio?: boolean; song_name?: string; artist_name?: string }
  error?: string
  [k: string]: unknown
}

async function runActor(url: string): Promise<ApifyItem[]> {
  const actor = env.apifyActor
  const endpoint = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${encodeURIComponent(env.apifyToken)}`

  // A cold actor takes a while to boot and scrape, so the timeout is generous —
  // but bounded, because Node's default is none and a hung run would stall the
  // capture silently with no output at all.
  let res: Response
  try {
    res = await withRetry(
      () => fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ directUrls: [url], resultsType: 'posts', resultsLimit: 1, addParentData: false }),
        signal: AbortSignal.timeout(240_000),
      }),
      { label: `Apify ${actor}`, attempts: 3, baseMs: 3000 },
    )
  } catch (err) {
    throw new Error(`Could not reach Apify (actor ${actor}).`, { cause: err })
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Apify actor ${actor} failed (${res.status}): ${body.slice(0, 400)}`)
  }
  return (await res.json()) as ApifyItem[]
}

function pickItem(items: ApifyItem[], url: string): ApifyItem {
  const item = items.find((i) => !i.error)
  if (!item) {
    const why = items[0]?.error ?? 'actor returned no items'
    throw new Error(
      `Could not resolve ${url}: ${why}\n` +
      `The post may be private or deleted, or the actor may have broken. ` +
      `Try a different APIFY_INSTAGRAM_ACTOR in .env.`,
    )
  }
  return item
}

async function download(url: string, dest: string): Promise<void> {
  // Instagram CDN links are signed and short-lived, so a stall here usually
  // means a dead link rather than a slow one. Fail fast and name the URL.
  let res: Response
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(90_000) })
  } catch (err) {
    throw new Error(`Could not download media from the Instagram CDN (link may have expired).`, { cause: err })
  }
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url.slice(0, 120)}`)
  await writeFile(dest, Buffer.from(await res.arrayBuffer()))
}

/** A slide's picture, tolerating the several shapes actors use for it. */
function stillUrls(slide: ApifyItem): string[] {
  if (slide.displayUrl) return [slide.displayUrl]
  return slide.images?.length ? slide.images : []
}

const dedupe = (urls: string[]) => [...new Set(urls.filter(Boolean))]

export const instagramResolver: Resolver = {
  name: 'apify-instagram',

  matches(url) {
    return /instagram\.com/i.test(url)
  },

  async resolve(url, workdir): Promise<ResolvedMedia> {
    const item = pickItem(await runActor(url), url)

    // A carousel ("Sidecar") exposes its slides as childPosts; a single post is
    // its own slide. Each slide carries its picture as `displayUrl`, while
    // `images` is often present but EMPTY — so `images ?? displayUrl` silently
    // yields nothing, because ?? only falls back on null/undefined.
    const slides = item.childPosts?.length ? item.childPosts : [item]

    let videoPath: string | null = null
    const videoUrl = slides.find((s) => s.videoUrl)?.videoUrl
    if (videoUrl) {
      videoPath = path.join(workdir, 'video.mp4')
      await download(videoUrl, videoPath)
    }

    // Instagram delivers DASH, so `videoUrl` is frequently a video-ONLY
    // representation and the speech lives in a separate `audioUrl`. Missing
    // this reads as "this reel has no audio" when it plainly does.
    let separateAudioPath: string | null = null
    const audioUrl = item.audioUrl ?? slides.find((s) => s.audioUrl)?.audioUrl
    if (videoPath && audioUrl) {
      separateAudioPath = path.join(workdir, 'audio-source')
      await download(audioUrl, separateAudioPath)
    }

    // Still slides matter as much as video: a carousel has no audio at all, so
    // the caption and these images ARE the whole evidence bundle.
    const stills = dedupe([
      ...slides.filter((s) => !s.videoUrl).flatMap(stillUrls),
      // Some actors only populate the parent's `images` for a carousel.
      ...(videoUrl ? [] : item.images ?? []),
    ])

    const imagePaths: string[] = []
    for (const [i, src] of stills.entries()) {
      const dest = path.join(workdir, `image-${String(i).padStart(2, '0')}.jpg`)
      await download(src, dest)
      imagePaths.push(dest)
    }

    if (!videoPath && imagePaths.length === 0) {
      throw new Error(
        `Resolved ${url} (type=${item.type ?? '?'}) but found no video or image URLs. ` +
        `The actor's output shape has probably changed — check stillUrls() in resolvers/instagram.ts.`,
      )
    }

    const text = item.caption ?? ''
    return {
      platform: 'instagram',
      url,
      author: item.ownerUsername ?? item.ownerFullName ?? null,
      postedAt: item.timestamp ?? null,
      caption: { text, hashtags: parseHashtags(text), locationTag: item.locationName ?? null },
      videoPath,
      separateAudioPath,
      usesOriginalAudio: item.musicInfo?.uses_original_audio ?? null,
      imagePaths,
    }
  },
}
