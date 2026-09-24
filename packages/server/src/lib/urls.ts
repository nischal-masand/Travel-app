/**
 * One reel, one identity — however it was shared.
 *
 * Instagram's share button appends a tracking parameter (`?igsh=...`) that is
 * different every time, and the same post is reachable as /reel/, /reels/, /p/
 * and /<username>/reel/. YouTube has watch?v=, youtu.be/ and /shorts/. Hashing
 * the raw URL made each of those a separate capture: downloaded, transcribed,
 * OCR'd and geocoded again, spending free-tier quota to produce a duplicate.
 *
 * So a capture's identity is the MEDIA it points at, not the string it arrived
 * as. Anything unrecognised falls back to the URL minus its query and hash,
 * which still collapses the common tracking-parameter case.
 */

export interface MediaRef {
  /** Stable identity, e.g. "instagram:DXaPSaMEt1s". */
  key: string
  /** A clean URL for the resolver: no tracking, one canonical form. */
  url: string
}

const IG_CODE = /instagram\.com\/(?:[A-Za-z0-9._]+\/)?(reel|reels|p|tv)\/([A-Za-z0-9_-]+)/i
const YT_WATCH = /(?:youtube\.com|m\.youtube\.com|music\.youtube\.com)\/watch\?(?:.*&)?v=([A-Za-z0-9_-]{6,})/i
const YT_SHORT = /youtu\.be\/([A-Za-z0-9_-]{6,})/i
const YT_SHORTS = /youtube\.com\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{6,})/i
const TT_VIDEO = /tiktok\.com\/@([A-Za-z0-9._-]+)\/video\/(\d+)/i

export function mediaRef(input: string): MediaRef {
  const raw = input.trim()

  const ig = raw.match(IG_CODE)
  if (ig) {
    // The KEY ignores the path kind — /p/X and /reel/X are the same media. The
    // URL keeps it: a carousel lives at /p/, and handing the resolver a /reel/
    // URL for one is an untested bet. Only the username prefix and the
    // tracking query are dropped.
    const kind = ig[1]!.toLowerCase() === 'reels' ? 'reel' : ig[1]!.toLowerCase()
    return { key: `instagram:${ig[2]}`, url: `https://www.instagram.com/${kind}/${ig[2]}/` }
  }

  const yt = raw.match(YT_WATCH) ?? raw.match(YT_SHORT) ?? raw.match(YT_SHORTS)
  if (yt) {
    const isShort = /\/shorts\//i.test(raw)
    return {
      key: `youtube:${yt[1]}`,
      url: isShort ? `https://www.youtube.com/shorts/${yt[1]}` : `https://www.youtube.com/watch?v=${yt[1]}`,
    }
  }

  const tt = raw.match(TT_VIDEO)
  if (tt) return { key: `tiktok:${tt[2]}`, url: `https://www.tiktok.com/@${tt[1]}/video/${tt[2]}` }

  // Unrecognised shape (e.g. a vm.tiktok.com short link, which only resolves by
  // following the redirect): still drop the query and fragment, where tracking
  // parameters live, and lower-case the host.
  try {
    const u = new URL(raw)
    u.search = ''
    u.hash = ''
    u.hostname = u.hostname.toLowerCase()
    const clean = u.toString()
    return { key: `url:${clean}`, url: clean }
  } catch {
    return { key: `url:${raw}`, url: raw }
  }
}
