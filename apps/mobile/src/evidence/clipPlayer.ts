import { useSyncExternalStore } from 'react'
import { createAudioPlayer, type AudioPlayer, type AudioStatus } from 'expo-audio'

/**
 * Plays the few seconds of a reel around a spoken name, so you can hear it
 * rather than trust the transcription — without reopening Instagram.
 *
 * One player for the whole app, because two clips talking over each other is
 * never what anyone wants: starting a clip stops whichever one was playing.
 * Every clip button reads the same small store, so exactly one of them shows
 * "Stop" at a time.
 *
 * The same code runs on web and native. expo-audio 57 ships a web player of its
 * own (an HTML5 <audio> element under the hood), so there is no .web variant.
 *
 * Why the HEAD probes: the server answers 404 when a capture has no audio at
 * all (a photo carousel, a reel on a licensed music track, media cleaned up).
 * A native player just sits there on a 404 — no status code, no clear error —
 * which would be a dead button. Asking the server first turns that into a
 * button that says why it can't play. One probe per capture is enough, because
 * "no audio" is a property of the capture, not of the second.
 */

export const NO_AUDIO_REASON = 'No audio kept for this reel'

/** A clip that hasn't started after this long is reported, not left spinning. */
const LOAD_TIMEOUT_MS = 12_000
/**
 * The server cuts three seconds. If no "finished" event has arrived well after
 * that, the button goes back to "Hear it" rather than claiming to still play.
 */
const MAX_PLAY_MS = 8_000

export type ClipPhase = 'loading' | 'playing'
export type AudioAvailability = 'checking' | 'yes' | 'no'

export interface ClipState {
  /** URL of the clip loading or playing; null when nothing is. */
  active: string | null
  phase: ClipPhase | null
  /** Why a particular clip couldn't be played, keyed by its URL. */
  failed: Readonly<Record<string, string>>
  /** Whether a capture has any audio to cut, keyed by capture id. */
  audio: Readonly<Record<string, AudioAvailability>>
}

// --- store -----------------------------------------------------------------

let state: ClipState = { active: null, phase: null, failed: {}, audio: {} }
const listeners = new Set<() => void>()

function update(patch: Partial<ClipState>): void {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const snapshot = () => state

export function useClipState(): ClipState {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

function setAudio(captureId: string, value: AudioAvailability | undefined): void {
  const next = { ...state.audio }
  if (value === undefined) delete next[captureId]
  else next[captureId] = value
  update({ audio: next })
}

function withoutFailure(url: string): Record<string, string> {
  const next = { ...state.failed }
  delete next[url]
  return next
}

// --- probing ---------------------------------------------------------------

type Probe = 'ok' | 'no-audio' | { error: string }

/** URLs the server has already said yes to — no need to ask twice. */
const verified = new Set<string>()
const captureChecks = new Map<string, Promise<void>>()

async function probe(url: string): Promise<Probe> {
  let res: Response
  try {
    res = await fetch(url, { method: 'HEAD' })
  } catch {
    return { error: "Can't reach the server to fetch the clip" }
  }
  if (res.ok) return 'ok'
  if (res.status === 404) return 'no-audio'
  return { error: `The server couldn't cut this clip (HTTP ${res.status})` }
}

/**
 * Find out, once per capture, whether it has audio at all — so a reel without
 * any shows "no audio" up front instead of a button that fails when tapped.
 * `sampleUrl` is any clip of that capture; the server keeps what it cuts, so
 * this also warms the clip the user is most likely to press.
 */
export function checkCaptureAudio(captureId: string, sampleUrl: string): void {
  const known = state.audio[captureId]
  if (known === 'yes' || known === 'no' || captureChecks.has(captureId)) return
  setAudio(captureId, 'checking')
  const check = probe(sampleUrl).then((result) => {
    if (result === 'ok') {
      verified.add(sampleUrl)
      setAudio(captureId, 'yes')
    } else if (result === 'no-audio') {
      setAudio(captureId, 'no')
    } else {
      // Couldn't tell (server blip). Leave it unknown; a tap will ask again.
      setAudio(captureId, undefined)
    }
  }).finally(() => {
    captureChecks.delete(captureId)
  })
  captureChecks.set(captureId, check)
}

// --- playback --------------------------------------------------------------

let player: AudioPlayer | null = null
let token = 0
let timer: ReturnType<typeof setTimeout> | null = null

function clearTimer(): void {
  if (timer) clearTimeout(timer)
  timer = null
}

function pausePlayer(): void {
  try {
    player?.pause()
  } catch {
    // A player that can't pause has nothing playing.
  }
}

function settle(): void {
  clearTimer()
  update({ active: null, phase: null })
}

function fail(url: string, reason: string): void {
  clearTimer()
  const wasActive = state.active === url
  update({
    active: wasActive ? null : state.active,
    phase: wasActive ? null : state.phase,
    failed: { ...state.failed, [url]: reason },
  })
}

function onStatus(status: AudioStatus): void {
  const url = state.active
  if (!url) return
  if (status.error) {
    pausePlayer()
    fail(url, "Couldn't play this clip")
    return
  }
  if (status.didJustFinish) {
    settle()
    return
  }
  if (status.playing) {
    if (state.phase !== 'playing') {
      clearTimer()
      update({ phase: 'playing' })
      timer = setTimeout(() => {
        if (state.active === url) settle()
      }, MAX_PLAY_MS)
    }
    return
  }
  // Stopped part-way by something other than us (a phone call, another app).
  // currentTime > 0 matters: the web player reports playing=false alongside
  // `loadeddata`, at position 0, after it has already said it started.
  if (state.phase === 'playing' && status.currentTime > 0 && !status.isBuffering) settle()
}

function start(url: string, mine: number): void {
  try {
    if (!player) {
      player = createAudioPlayer({ uri: url }, { updateInterval: 250 })
      player.addListener('playbackStatusUpdate', onStatus)
    } else {
      player.replace({ uri: url })
    }
    player.play()
  } catch {
    fail(url, "Couldn't play this clip")
    return
  }
  timer = setTimeout(() => {
    if (mine === token && state.active === url && state.phase === 'loading') {
      pausePlayer()
      fail(url, "The clip didn't start. Try again.")
    }
  }, LOAD_TIMEOUT_MS)
}

/** Stop whatever clip is playing. Safe to call when nothing is. */
export function stopClip(): void {
  token++
  clearTimer()
  if (state.active === null) return
  pausePlayer()
  update({ active: null, phase: null })
}

/** Stop only if `url` is the clip playing — for a button leaving the screen. */
export function stopClipIfActive(url: string): void {
  if (state.active === url) stopClip()
}

/**
 * Play the clip at `url`, or stop it if it is the one already playing.
 *
 * When the capture is already known to have audio, playback starts in the same
 * tick as the tap: Safari only lets sound start from inside a user gesture, and
 * an awaited request in between would lose it.
 */
export async function toggleClip(captureId: string, url: string): Promise<void> {
  if (state.active === url) {
    stopClip()
    return
  }
  stopClip()
  const mine = ++token
  update({ active: url, phase: 'loading', failed: withoutFailure(url) })

  if (state.audio[captureId] !== 'yes' && !verified.has(url)) {
    const result = await probe(url)
    if (mine !== token) return
    if (result === 'no-audio') {
      setAudio(captureId, 'no')
      settle()
      return
    }
    if (result !== 'ok') {
      fail(url, result.error)
      return
    }
    verified.add(url)
    setAudio(captureId, 'yes')
  }
  // expo-audio's defaults suit a tapped clip: it plays with the ringer on
  // silent (playsInSilentMode defaults to true) and doesn't stop other apps'
  // audio. No setAudioModeAsync, so merely opening a screen changes nothing.
  start(url, mine)
}
