import { useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { Card, IconButton, Menu, ProgressBar, Text } from 'react-native-paper'
import type { ApiCaptureSummary } from '@reel/shared'
import { captureByline, relativeTime } from '../format'
import { space, useAppTheme } from '../theme'

/**
 * One shared reel in the inbox: who posted it, when you shared it, and what
 * the server is doing with it right now — in the server's own words.
 *
 * Delete lives in the card's overflow menu, where it can be found on every
 * platform; a long press opens the same confirmation as a shortcut.
 */
export function CaptureRow({ capture, onOpen, onDelete }: {
  capture: ApiCaptureSummary
  onOpen: () => void
  onDelete: () => void
}) {
  const { colors } = useAppTheme()
  const [menuOpen, setMenuOpen] = useState(false)
  // Until the pipeline has looked at the post, author and platform are unknown,
  // so a just-queued row falls back to the link itself.
  const title = captureByline(capture) || shortUrl(capture.url)
  const caption = capture.caption?.trim()

  return (
    <Card
      onPress={onOpen}
      onLongPress={onDelete}
      accessibilityLabel={`${title}. ${statusText(capture)}`}
      accessibilityHint="Opens the capture"
    >
      <Card.Title
        title={title}
        titleVariant="titleMedium"
        subtitle={relativeTime(capture.createdAt)}
        subtitleVariant="bodySmall"
        subtitleStyle={{ color: colors.onSurfaceVariant }}
        right={() => (
          <Menu
            visible={menuOpen}
            onDismiss={() => setMenuOpen(false)}
            anchor={
              <IconButton
                icon="dots-vertical"
                accessibilityLabel="More actions"
                onPress={() => setMenuOpen(true)}
              />
            }
          >
            <Menu.Item
              leadingIcon="delete-outline"
              title="Delete"
              onPress={() => {
                setMenuOpen(false)
                onDelete()
              }}
            />
          </Menu>
        )}
      />
      <Card.Content style={styles.content}>
        {caption
          ? <Text variant="bodyMedium" style={{ color: colors.onSurfaceVariant }} numberOfLines={2}>{caption}</Text>
          : null}
        <StatusLine capture={capture} />
      </Card.Content>
    </Card>
  )
}

function StatusLine({ capture }: { capture: ApiCaptureSummary }) {
  const { colors } = useAppTheme()
  switch (capture.status) {
    case 'queued':
      return <Text variant="labelLarge" style={{ color: colors.onSurfaceVariant }}>Queued</Text>
    case 'running':
      return (
        <View style={styles.running}>
          <ProgressBar indeterminate style={styles.progress} />
          <Text variant="bodySmall" style={{ color: colors.primary }} numberOfLines={2}>
            {capture.step ?? 'Starting'}
          </Text>
        </View>
      )
    case 'failed':
      // Verbatim: "quota exhausted" and "this post is private" need different
      // responses from the user, so the provider's own words are shown.
      return (
        <Text variant="bodySmall" style={{ color: colors.error }} numberOfLines={4}>
          {capture.error ?? 'Failed (the server gave no reason)'}
        </Text>
      )
    case 'done': {
      const checks = capture.needsCheckCount
      return (
        <Text variant="labelLarge">
          {placesText(capture.placeCount)}
          {checks > 0
            ? <Text variant="labelLarge" style={{ color: colors.needsCheck }}>{` · ${checks} to check`}</Text>
            : null}
        </Text>
      )
    }
  }
}

function placesText(n: number): string {
  if (n === 0) return 'No places found'
  return `${n} ${n === 1 ? 'place' : 'places'}`
}

/** Plain-words status, for screen readers. */
function statusText(capture: ApiCaptureSummary): string {
  switch (capture.status) {
    case 'queued': return 'Queued'
    case 'running': return capture.step ?? 'Starting'
    case 'failed': return `Failed: ${capture.error ?? 'no reason given'}`
    case 'done': return capture.needsCheckCount > 0
      ? `${placesText(capture.placeCount)}, ${capture.needsCheckCount} to check`
      : placesText(capture.placeCount)
  }
}

/** "instagram.com/reel/ABC/" — the link without its scheme, www. or query. */
function shortUrl(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/i, '').replace(/[?#].*$/, '')
}

const styles = StyleSheet.create({
  content: { gap: space.sm },
  running: { gap: space.sm },
  progress: { borderRadius: 2 },
})
