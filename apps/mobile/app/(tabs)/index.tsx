import { useEffect, useRef, useState } from 'react'
import { FlatList, Platform, RefreshControl, StyleSheet, View } from 'react-native'
import { router } from 'expo-router'
import { ActivityIndicator, Card } from 'react-native-paper'
import type { ApiCaptureSummary } from '@reel/shared'
import { api } from '../../src/api'
import { showDialog } from '../../src/components/dialogs'
import { EmptyState, ErrorBanner, Loading } from '../../src/components/ui'
import { AddLinkBox } from '../../src/inbox/AddLinkBox'
import { CaptureRow } from '../../src/inbox/CaptureRow'
import { useShareStatus } from '../../src/share/shareStatus'
import { space, useAppTheme } from '../../src/theme'
import { useApi } from '../../src/useApi'

/**
 * The inbox: every reel you've shared, and what the server is doing with it.
 *
 * Processing takes 30-60s, so while anything is queued or running the list
 * re-fetches on an interval; once everything has settled it stops asking.
 */
export default function InboxScreen() {
  const { colors } = useAppTheme()
  const inbox = useApi(() => api.listCaptures(), {
    pollWhile: (list) => list.some((x) => x.status === 'queued' || x.status === 'running'),
  })
  const [actionError, setActionError] = useState<Error | null>(null)

  // A link shared from another app is sent by the root layout; when the server
  // accepts it, reload so the new row appears (and polling starts).
  const share = useShareStatus()
  const reloadRef = useRef(inbox.reload)
  reloadRef.current = inbox.reload
  useEffect(() => {
    if (share.added > 0) void reloadRef.current()
  }, [share.added])

  function remove(capture: ApiCaptureSummary) {
    showDialog({
      title: 'Delete this reel?',
      body: 'Its places, tips and evidence are removed from Reel Trip. The original post is not affected.',
      actions: [
        { label: 'Cancel' },
        {
          label: 'Delete',
          destructive: true,
          onPress: async () => {
            setActionError(null)
            inbox.setData((list) => list?.filter((x) => x.id !== capture.id))
            try {
              await api.deleteCapture(capture.id)
            } catch (err) {
              setActionError(err instanceof Error ? err : new Error(String(err)))
            }
            // Either way, show what the server now has — which restores the
            // row if the delete didn't go through.
            void inbox.reload()
          },
        },
      ],
    })
  }

  const captures = inbox.data ?? []

  const header = (
    <View>
      <AddLinkBox onAdded={() => void inbox.reload()} />
      {share.sending ? <SendingRow url={share.sending} /> : null}
      {actionError ? <ErrorBanner error={actionError} /> : null}
      {inbox.error ? <ErrorBanner error={inbox.error} onRetry={() => void inbox.refresh()} /> : null}
    </View>
  )

  return (
    <FlatList
      data={captures}
      keyExtractor={(x) => x.id}
      renderItem={({ item }) => (
        <View style={styles.item}>
          <CaptureRow
            capture={item}
            onOpen={() => router.push(`/capture/${item.id}`)}
            onDelete={() => remove(item)}
          />
        </View>
      )}
      ListHeaderComponent={header}
      ListEmptyComponent={
        inbox.loading ? <Loading />
          // With an error and nothing loaded, the banner above says why; an
          // "empty inbox" message would be a lie.
          : inbox.error ? null
          : (
            <EmptyState
              icon="inbox-arrow-down"
              title="No reels yet"
              body={Platform.OS === 'web'
                ? 'Paste an Instagram, YouTube or TikTok link above and Reel Trip will find the places in it.'
                : 'Share a reel from Instagram to Reel Trip, or paste a link above.'}
            />
          )
      }
      ListFooterComponent={<View style={styles.footer} />}
      refreshControl={
        <RefreshControl
          refreshing={inbox.refreshing}
          onRefresh={() => void inbox.refresh()}
          tintColor={colors.primary}
          colors={[colors.primary]}
          progressBackgroundColor={colors.surfaceContainerHigh}
        />
      }
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.content}
      style={{ backgroundColor: colors.background }}
    />
  )
}

/** A link arriving from the share sheet, before the server has answered. */
function SendingRow({ url }: { url: string }) {
  return (
    <View style={styles.item}>
      <Card mode="contained">
        <Card.Title
          title="Adding the link you shared"
          subtitle={url}
          left={() => <ActivityIndicator size="small" />}
        />
      </Card>
    </View>
  )
}

const styles = StyleSheet.create({
  content: { flexGrow: 1 },
  item: { paddingHorizontal: space.lg, paddingTop: space.md },
  footer: { height: space.xl },
})
