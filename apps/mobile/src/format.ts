import type { ApiCapture, SourceType } from '@reel/shared'

/** 0:14, 1:05 — how a moment in a reel is written everywhere in the app. */
export function timestamp(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return ''
  const s = Math.max(0, Math.round(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * Where a piece of evidence came from, in words a person uses. These three
 * labels are the vocabulary of the whole app: "said", "on screen", "caption".
 */
export function sourceLabel(source: SourceType): string {
  switch (source) {
    case 'transcript': return 'said'
    case 'onScreenText': return 'on screen'
    case 'caption': return 'caption'
  }
}

/** One line for an inbox row or a header: "@johnmarcoasks · Instagram". */
export function captureByline(c: Pick<ApiCapture, 'author' | 'platform'>): string {
  const platform = c.platform === 'youtube' ? 'YouTube'
    : c.platform === 'tiktok' ? 'TikTok'
    : c.platform === 'instagram' ? 'Instagram'
    : null
  return [c.author ? `@${c.author}` : null, platform].filter(Boolean).join(' · ')
}

/** "just now", "5m ago", "3h ago", "2d ago". SQLite timestamps are UTC with no zone. */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const normalized = /[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso.replace(' ', 'T')}Z`
  const then = Date.parse(normalized)
  if (Number.isNaN(then)) return ''
  const mins = Math.round((Date.now() - then) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}
