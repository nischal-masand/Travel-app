/**
 * Finds the reel link in whatever another app handed us.
 *
 * Instagram's share sheet sends TEXT like
 *   "Check out this reel https://www.instagram.com/reel/ABC/?igsh=xyz"
 * — sometimes with the link broken out as `webUrl`, sometimes only inside the
 * text. And when there are several links, the share library's `webUrl` is just
 * the first one it saw, which may be a link we can't use. So this looks at
 * both, and returns the first link the server can actually process.
 *
 * Pure on purpose: no React Native imports, so it runs under plain Node in
 * extractUrl.smoke.ts.
 *
 * Query strings are kept as they are (including ?igsh=). The server normalises
 * URLs; guessing which parameters matter is its job, not the phone's.
 */

/** Hosts the server has a resolver for. Subdomains (www., m., vm.) count. */
const SUPPORTED_DOMAINS = ['instagram.com', 'youtube.com', 'youtu.be', 'tiktok.com'] as const

const LEADING_PUNCTUATION = /^[(\[{<'"«“‘]+/
const TRAILING_PUNCTUATION = /[.,;:!?)\]}>'"»”’]+$/

/** The host of an http(s) URL, lower-cased, or null if it isn't one. */
function hostOf(url: string): string | null {
  // A regex rather than `new URL()`: React Native's URL implementation has
  // historically thrown on `.hostname`, and this must behave identically in
  // Node and on a phone.
  const m = /^https?:\/\/(?:[^@/?#\s]*@)?([^/?#:\s]+)/i.exec(url)
  if (!m || !m[1]) return null
  return m[1].toLowerCase().replace(/\.$/, '')
}

/** True for an http(s) link on a host the server can process. */
export function isSupportedUrl(url: string): boolean {
  const host = hostOf(url.trim())
  if (!host) return false
  return SUPPORTED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))
}

/**
 * Turns one whitespace-separated word into a candidate URL, or null.
 * Handles "(https://youtu.be/x)." and "Watch:https://..." as well as a bare
 * "instagram.com/reel/ABC" someone typed without the scheme.
 */
function candidateFrom(word: string): string | null {
  const trimmed = word.replace(LEADING_PUNCTUATION, '').replace(TRAILING_PUNCTUATION, '')
  if (!trimmed) return null

  const schemeAt = trimmed.search(/https?:\/\//i)
  if (schemeAt >= 0) return trimmed.slice(schemeAt)

  // No scheme: only accept it if it starts with a supported host, so ordinary
  // words and file names are never mistaken for links.
  const withScheme = `https://${trimmed}`
  const host = hostOf(withScheme)
  if (host && SUPPORTED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) return withScheme
  return null
}

/** The first supported link in a block of text, or null. */
export function firstSupportedUrlIn(text: string | null | undefined): string | null {
  if (!text) return null
  for (const word of text.split(/\s+/)) {
    const candidate = candidateFrom(word)
    if (candidate && isSupportedUrl(candidate)) return candidate
  }
  return null
}

/**
 * The link to send to the server, or null when the share held nothing we can
 * process (a photo, plain text, a link to some other site).
 */
export function extractSupportedUrl(shared: { webUrl?: string | null; text?: string | null }): string | null {
  const webUrl = shared.webUrl?.trim()
  if (webUrl) {
    const candidate = candidateFrom(webUrl) ?? webUrl
    if (isSupportedUrl(candidate)) return candidate
  }
  return firstSupportedUrlIn(shared.text)
}
