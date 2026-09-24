import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import type { ApiCaptureSummary } from '@reel/shared'
import { Card } from '../components/ui'
import { captureByline, relativeTime } from '../format'
import { font, space, useColors } from '../theme'

/**
 * One shared reel in the inbox: who posted it, when you shared it, and what
 * the server is doing with it right now — in the server's own words.
 */
export function CaptureRow({ capture, onOpen, onDelete }: {
  capture: ApiCaptureSummary
  onOpen: () => void
  onDelete: () => void
}) {
  const c = useColors()
  // Until the pipeline has looked at the post, author and platform are unknown,
  // so a just-queued row falls back to the link itself.
  const title = captureByline(capture) || shortUrl(capture.url)
  const caption = capture.caption?.trim()

  return (
    <Pressable
      onPress={onOpen}
      onLongPress={onDelete}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${statusText(capture)}`}
      accessibilityHint="Opens the capture. Long-press to delete it."
      accessibilityActions={[{ name: 'activate' }, { name: 'delete', label: 'Delete' }]}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === 'delete') onDelete()
        else onOpen()
      }}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
    >
      <Card>
        <View style={styles.top}>
          <Text style={[styles.title, { color: c.text }]} numberOfLines={1}>{title}</Text>
          <Text style={[styles.time, { color: c.textFaint }]}>{relativeTime(capture.createdAt)}</Text>
        </View>
        {caption
          ? <Text style={[styles.caption, { color: c.textMuted }]} numberOfLines={2}>{caption}</Text>
          : null}
        <StatusLine capture={capture} />
      </Card>
    </Pressable>
  )
}

function StatusLine({ capture }: { capture: ApiCaptureSummary }) {
  const c = useColors()
  switch (capture.status) {
    case 'queued':
      return <Text style={[styles.status, { color: c.textMuted }]}>Queued</Text>
    case 'running':
      return (
        <View style={styles.running}>
          <ActivityIndicator size="small" color={c.accent} />
          <Text style={[styles.status, styles.flex, { color: c.accent }]} numberOfLines={2}>
            {capture.step ?? 'Starting'}
          </Text>
        </View>
      )
    case 'failed':
      // Verbatim: "quota exhausted" and "this post is private" need different
      // responses from the user, so the provider's own words are shown.
      return (
        <Text style={[styles.status, { color: c.danger }]} numberOfLines={4}>
          {capture.error ?? 'Failed (the server gave no reason)'}
        </Text>
      )
    case 'done': {
      const checks = capture.needsCheckCount
      return (
        <Text style={[styles.status, { color: c.text }]}>
          {placesText(capture.placeCount)}
          {checks > 0
            ? <Text style={{ color: c.needsCheck, fontWeight: '600' }}>{` · ${checks} to check`}</Text>
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
  top: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  title: { flex: 1, fontSize: font.body, fontWeight: '600' },
  time: { fontSize: font.small },
  caption: { fontSize: font.small, lineHeight: 17 },
  status: { fontSize: font.small, lineHeight: 17 },
  running: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  flex: { flex: 1 },
})
