import { useCallback, useState } from 'react'
import { FlatList, RefreshControl, StyleSheet, View } from 'react-native'
import { router, useFocusEffect } from 'expo-router'
import { Snackbar, Text } from 'react-native-paper'
import type { ApiPlace, ApiTrayItem } from '@reel/shared'
import { api } from '../../src/api'
import { EmptyState, ErrorBanner, Loading } from '../../src/components/ui'
import { PlaceCard, ReviewActions, stopClip, toError } from '../../src/evidence'
import { captureByline } from '../../src/format'
import { useApi } from '../../src/useApi'
import { space, useAppTheme } from '../../src/theme'

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
  const { colors } = useAppTheme()
  const { data, error, loading, refreshing, refresh, reload, setData } = useApi(() => api.listNeedsCheck())
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set())
  const [failures, setFailures] = useState<Readonly<Record<string, Error>>>({})
  const [notice, setNotice] = useState<string | null>(null)

  // Leaving the tab silences whatever clip was playing.
  useFocusEffect(useCallback(() => () => stopClip(), []))

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

  async function verdict(item: ApiTrayItem, kind: 'confirm' | 'dismiss') {
    const index = data?.findIndex((p) => p.id === item.id) ?? -1
    setFailure(item.id, null)
    markPending(item.id, true)
    setData((prev) => prev?.filter((p) => p.id !== item.id))
    try {
      if (kind === 'confirm') await api.confirmPlace(item.id)
      else await api.dismissPlace(item.id)
      setNotice(kind === 'confirm' ? `Confirmed ${item.name}` : `Dismissed ${item.name}`)
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
      setNotice(`Confirmed as ${updated.canonicalName ?? updated.name}`)
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
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void refresh()}
            tintColor={colors.primary}
            colors={[colors.primary]}
            progressBackgroundColor={colors.surfaceContainerHigh}
          />
        }
        ListHeaderComponent={
          items.length > 0
            ? (
              <Text variant="bodyMedium" style={[styles.intro, { color: colors.onSurfaceVariant }]}>
                {items.length === 1 ? '1 place needs' : `${items.length} places need`} your call. Each comes with the moment in the reel that named it.
              </Text>
            )
            : null
        }
        ListEmptyComponent={
          <EmptyState icon="check-all" title="Nothing to check" body="Every place from your reels is either confirmed or dismissed." />
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
      <Snackbar visible={notice !== null} onDismiss={() => setNotice(null)} duration={4000}>
        {notice ?? ''}
      </Snackbar>
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
  intro: { marginBottom: space.lg },
})
