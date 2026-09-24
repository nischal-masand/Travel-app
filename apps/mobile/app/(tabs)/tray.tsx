import { useCallback, useEffect, useRef, useState } from 'react'
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native'
import { router, useFocusEffect } from 'expo-router'
import type { ApiPlace, ApiTrayItem } from '@reel/shared'
import { api } from '../../src/api'
import { EmptyState, ErrorBanner, Loading } from '../../src/components/ui'
import { PlaceCard, ReviewActions, stopClip, toError } from '../../src/evidence'
import { captureByline } from '../../src/format'
import { useApi } from '../../src/useApi'
import { font, radius, space, useColors } from '../../src/theme'

/**
 * The Check tray: every place the pipeline wouldn't vouch for on its own,
 * each with the moment of the reel that named it — the frame to look at and the
 * line to hear — so you can decide without reopening Instagram.
 *
 * Confirm and dismiss take the card away at once and put it back if the server
 * says no. A card whose verdict is still in flight stays hidden even if a
 * refresh lands in between, so nothing flickers back.
 */
export default function TrayScreen() {
  const c = useColors()
  const { data, error, loading, refreshing, refresh, reload, setData } = useApi(() => api.listNeedsCheck())
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set())
  const [failures, setFailures] = useState<Readonly<Record<string, Error>>>({})
  const [notice, setNotice] = useState<string | null>(null)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Leaving the tab silences whatever clip was playing.
  useFocusEffect(useCallback(() => () => stopClip(), []))
  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
  }, [])

  const markPending = (id: string, on: boolean) => setPending((prev) => {
    const next = new Set(prev)
    if (on) next.add(id)
    else next.delete(id)
    return next
  })

  const setFailure = (id: string, err: Error | null) => setFailures((prev) => {
    const next = { ...prev }
    if (err) next[id] = err
    else delete next[id]
    return next
  })

  const announce = (text: string) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    setNotice(text)
    noticeTimer.current = setTimeout(() => setNotice(null), 4000)
  }

  async function verdict(item: ApiTrayItem, kind: 'confirm' | 'dismiss') {
    const index = data?.findIndex((p) => p.id === item.id) ?? -1
    setFailure(item.id, null)
    markPending(item.id, true)
    setData((prev) => prev?.filter((p) => p.id !== item.id))
    try {
      if (kind === 'confirm') await api.confirmPlace(item.id)
      else await api.dismissPlace(item.id)
      announce(kind === 'confirm' ? `Confirmed ${item.name}.` : `Dismissed ${item.name}.`)
      await reload()
    } catch (err) {
      setData((prev) => restore(prev, item, index))
      setFailure(item.id, toError(err))
    } finally {
      markPending(item.id, false)
    }
  }

  async function correct(item: ApiTrayItem, name: string): Promise<ApiPlace> {
    setFailure(item.id, null)
    // Waits for Google: until it answers there's nothing to be optimistic about.
    // Errors (422 "not found on Google", 503) propagate to the card to show.
    const updated = await api.correctPlace(item.id, name)
    if (updated.status === 'needs_check') {
      // A loose match on the typed name: keep the card, show the new suggestion.
      setData((prev) => prev?.map((p) => (p.id === item.id ? { ...p, ...updated } : p)))
    } else {
      markPending(item.id, true)
      setData((prev) => prev?.filter((p) => p.id !== item.id))
      announce(`Confirmed as ${updated.canonicalName ?? updated.name}.`)
      void reload().finally(() => markPending(item.id, false))
    }
    return updated
  }

  if (loading) return <Loading />
  if (!data) {
    return error ? <ErrorBanner error={error} onRetry={() => void refresh()} /> : <Loading />
  }

  const items = data.filter((p) => !pending.has(p.id))

  return (
    <View style={styles.screen}>
      {error ? <ErrorBanner error={error} onRetry={() => void refresh()} /> : null}
      <FlatList
        data={items}
        keyExtractor={(p) => p.id}
        contentContainerStyle={styles.list}
        ItemSeparatorComponent={Separator}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={c.accent} colors={[c.accent]} />
        }
        ListHeaderComponent={
          notice || items.length > 0
            ? (
              <View style={styles.header}>
                {notice
                  ? <Text style={[styles.notice, { color: c.text, backgroundColor: c.surfaceAlt }]} accessibilityLiveRegion="polite">{notice}</Text>
                  : null}
                {items.length > 0
                  ? (
                    <Text style={[styles.intro, { color: c.textMuted }]}>
                      {items.length === 1 ? '1 place needs' : `${items.length} places need`} your call. Each comes with the moment in the reel that named it.
                    </Text>
                  )
                  : null}
              </View>
            )
            : null
        }
        ListEmptyComponent={
          <EmptyState title="Nothing to check" body="Every place from your reels is either confirmed or dismissed." />
        }
        renderItem={({ item }) => (
          <PlaceCard
            place={item}
            from={{
              label: `from ${captureByline(item.capture) || 'this reel'}`,
              onPress: () => router.push(`/capture/${item.capture.id}`),
            }}
          >
            <ReviewActions
              place={item}
              error={failures[item.id] ?? null}
              onConfirm={() => void verdict(item, 'confirm')}
              onDismiss={() => void verdict(item, 'dismiss')}
              onCorrect={(name) => correct(item, name)}
            />
          </PlaceCard>
        )}
      />
    </View>
  )
}

/** Put a card back where it was, unless a refresh already brought it back. */
function restore(list: ApiTrayItem[] | undefined, item: ApiTrayItem, index: number): ApiTrayItem[] | undefined {
  if (!list) return [item]
  if (list.some((p) => p.id === item.id)) return list
  const next = [...list]
  next.splice(index < 0 ? next.length : Math.min(index, next.length), 0, item)
  return next
}

function Separator() {
  return <View style={styles.separator} />
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  list: { padding: space.lg, flexGrow: 1 },
  separator: { height: space.lg },
  header: { gap: space.md, marginBottom: space.lg },
  notice: { fontSize: font.body, fontWeight: '600', padding: space.md, borderRadius: radius.md, overflow: 'hidden' },
  intro: { fontSize: font.body, lineHeight: 21 },
})
