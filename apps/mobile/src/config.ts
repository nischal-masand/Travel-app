import Constants from 'expo-constants'
import { Platform } from 'react-native'

/**
 * Where the reel-trip server lives.
 *
 * On a phone, `localhost` is the phone — so the obvious default silently points
 * at nothing. Instead, reuse the host the Expo dev server was reached on: if the
 * app loaded its JavaScript from 192.168.1.20:8081, the API is almost certainly
 * on 192.168.1.20 too. EXPO_PUBLIC_API_URL overrides everything, which is what
 * you want for ngrok or a deployed server.
 */
const API_PORT = 3000

function resolveApiUrl(): string {
  const explicit = process.env.EXPO_PUBLIC_API_URL?.trim()
  if (explicit) return explicit.replace(/\/+$/, '')

  if (Platform.OS === 'web') {
    const host = typeof window !== 'undefined' ? window.location.hostname : 'localhost'
    return `http://${host}:${API_PORT}`
  }

  const hostUri = Constants.expoConfig?.hostUri ?? ''
  const host = hostUri.split(':')[0]
  if (host) return `http://${host}:${API_PORT}`

  // A standalone build with no dev server and no override has nowhere sensible
  // to point. Fail visibly in the UI rather than guess.
  return `http://localhost:${API_PORT}`
}

export const API_URL = resolveApiUrl()

/** How often a queued or running capture is re-fetched. */
export const POLL_MS = 4000
