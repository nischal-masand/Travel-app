import { useCallback, useEffect, useRef, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { POLL_MS } from './config'

/**
 * Load data for a screen: on focus, on demand (pull-to-refresh), and — while
 * `pollWhile` says so — on an interval.
 *
 * Polling exists because processing a reel takes 30-60s on the server and the
 * app only learns it finished by asking. It stops by itself once the condition
 * clears, so an idle inbox makes no requests at all.
 */
export function useApi<T>(
  fetcher: () => Promise<T>,
  opts: { pollWhile?: (data: T) => boolean } = {},
) {
  const [data, setData] = useState<T | undefined>(undefined)
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  // Held in refs so a new closure each render doesn't restart the interval.
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher
  const pollRef = useRef(opts.pollWhile)
  pollRef.current = opts.pollWhile

  const load = useCallback(async (mode: 'initial' | 'refresh' | 'silent') => {
    if (mode === 'refresh') setRefreshing(true)
    try {
      const next = await fetcherRef.current()
      setData(next)
      setError(null)
    } catch (err) {
      // Keep showing the last good data: a blip mid-poll shouldn't blank the screen.
      setError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      setLoading(false)
      if (mode === 'refresh') setRefreshing(false)
    }
  }, [])

  useFocusEffect(useCallback(() => {
    void load('silent')
  }, [load]))

  const shouldPoll = data !== undefined && (pollRef.current?.(data) ?? false)
  useEffect(() => {
    if (!shouldPoll) return
    const timer = setInterval(() => void load('silent'), POLL_MS)
    return () => clearInterval(timer)
  }, [shouldPoll, load])

  return {
    data,
    error,
    /** True only until the first response (or failure). */
    loading: loading && data === undefined,
    refreshing,
    refresh: () => load('refresh'),
    reload: () => load('silent'),
    /** Optimistically replace local data after a mutation, before the refetch lands. */
    setData,
  }
}
