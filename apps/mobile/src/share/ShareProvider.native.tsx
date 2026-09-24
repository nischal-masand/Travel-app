import { useEffect, useRef, type ReactNode } from 'react'
import { router, useRootNavigationState } from 'expo-router'
import { ShareIntentProvider, useShareIntentContext, type ShareIntent } from 'expo-share-intent'
import { api, ApiRequestError } from '../api'
import { showDialog } from '../components/dialogs'
import { extractSupportedUrl } from './extractUrl'
import { shareStatus } from './shareStatus'

/**
 * NATIVE (Android and iOS). Metro picks this file over ShareProvider.tsx.
 *
 * Catches a reel shared to Reel Trip from Instagram, YouTube or TikTok —
 * whether the share cold-started the app or reached it while running — sends
 * the link to the server, and takes you to the inbox to watch it process.
 *
 * Only works in a custom dev build or a release build: Expo Go has no share
 * extension, so there the share sheet never offers the app and this is inert.
 */
export function ShareProvider({ children }: { children: ReactNode }) {
  return (
    <ShareIntentProvider>
      {children}
      <ShareHandler />
    </ShareIntentProvider>
  )
}

/**
 * A share must be submitted exactly once. Re-sending the same link makes the
 * server re-queue it — download, transcription and OCR all over again, on
 * free-tier quota — so two guards:
 *
 *  1. The share object itself. The library builds a new object per share, so
 *     an effect that re-runs (StrictMode, a re-render) sees the same object and
 *     skips it.
 *  2. The URL, for a short window. On Android a cold-start share can be
 *     delivered twice (once on mount, once when the app turns active) as two
 *     separate objects before the first reset lands. Module scope, so it also
 *     survives the provider remounting.
 *
 * A failed send clears guard 2, so sharing again straight away does retry.
 */
const DUPLICATE_WINDOW_MS = 30_000
let lastSent: { url: string; at: number } | null = null

function ShareHandler() {
  const { hasShareIntent, shareIntent, resetShareIntent, error } = useShareIntentContext()
  // Navigating before the root navigator has mounted throws; a cold-start
  // share can arrive that early.
  const navReady = Boolean(useRootNavigationState()?.key)

  const handled = useRef<ShareIntent | null>(null)
  // resetShareIntent is a new function every render; hold the latest in a ref
  // so it doesn't re-trigger the effect.
  const resetRef = useRef(resetShareIntent)
  resetRef.current = resetShareIntent

  useEffect(() => {
    if (!hasShareIntent || !navReady) return
    if (handled.current === shareIntent) return
    handled.current = shareIntent

    const url = extractSupportedUrl({ webUrl: shareIntent.webUrl, text: shareIntent.text })
    // Clear it now, before any await, so the native side can't hand it back.
    resetRef.current()

    if (!url) {
      explainUnsupportedShare(shareIntent)
      return
    }

    if (lastSent && lastSent.url === url && Date.now() - lastSent.at < DUPLICATE_WINDOW_MS) {
      goToInbox()
      return
    }
    lastSent = { url, at: Date.now() }
    void send(url)
  }, [hasShareIntent, shareIntent, navReady])

  // The library couldn't read what the other app sent. Say so, in its words,
  // rather than leaving the user wondering why nothing happened.
  const shownError = useRef<string | null>(null)
  useEffect(() => {
    if (!error) { shownError.current = null; return }
    if (shownError.current === error) return
    shownError.current = error
    showDialog({ title: "Couldn't read what was shared", body: error })
  }, [error])

  return null
}

async function send(url: string) {
  // Show the inbox straight away, with an "adding" row, rather than leaving
  // the user staring at whatever screen the app was on while the request runs.
  shareStatus.sending(url)
  goToInbox()
  try {
    await api.createCapture(url)
    shareStatus.added()
  } catch (err) {
    lastSent = null
    shareStatus.failed()
    // The server's own words: "unsupported link" plus what IS supported, or
    // exactly which address it couldn't reach. Never "something went wrong".
    const message = err instanceof ApiRequestError && err.detail
      ? `${err.message}\n\n${err.detail}`
      : err instanceof Error ? err.message : String(err)
    showDialog({ title: "Couldn't add the shared link", body: `${message}\n\n${url}` })
  }
}

/**
 * The inbox is the index tab. From a pushed screen (a capture), pop back down
 * to the tabs; from another tab, switch to it. A plain replace('/') from a
 * capture screen would stack a second copy of the tabs on top of the first.
 */
function goToInbox() {
  if (router.canDismiss()) router.dismissTo('/')
  else router.navigate('/')
}

function explainUnsupportedShare(shared: ShareIntent) {
  const gotFiles = (shared.files?.length ?? 0) > 0
  const gotOtherLink = Boolean(shared.webUrl)
  const what = gotFiles
    ? 'That share was a photo or video file, not a link. Reel Trip needs the link to the post so it can read the caption and find where it came from.'
    : gotOtherLink
      ? `That link isn't one Reel Trip can read:\n${shared.webUrl}`
      : "That share didn't include a link."
  showDialog({
    title: 'No reel link found',
    body: `${what}\n\nReel Trip works with Instagram posts and reels, YouTube videos and Shorts, and TikTok videos. Use the app's Share button on the post and pick Reel Trip, or copy the link and paste it in the Inbox.`,
  })
}
