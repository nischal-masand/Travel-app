import { useState } from 'react'
import { Modal, StyleSheet, View } from 'react-native'
import { Image } from 'expo-image'
import { Appbar, Button, Icon, Surface, Text, TouchableRipple } from 'react-native-paper'
import { evidence } from '../api'
import { timestamp } from '../format'
import { shape, space, useAppTheme } from '../theme'

/**
 * The still at the moment a place was named, cut from the stored video by the
 * server — the reason you never have to scrub a reel on Instagram.
 *
 * Sized to the frame's own shape (reels are 9:16, YouTube is usually 16:9) and
 * never cropped: the text burned into the video is often the evidence. Tapping
 * opens it full screen, because on-screen text is unreadable at thumbnail size.
 * A frame that won't load (media cleaned up) disappears rather than leaving a
 * broken box; the quote beside it still stands on its own.
 */

/** Longest side of a thumbnail. Portrait reels come out 113 × 200. */
const THUMB = 200

export function EvidenceFrame({ captureId, seconds, title, quote }: {
  captureId: string
  seconds: number
  /** Shown above the enlarged frame, e.g. "on screen · 0:53". */
  title: string
  /** The verbatim quote, shown under the enlarged frame to compare against. */
  quote?: string
}) {
  const { colors } = useAppTheme()
  const uri = evidence.frameUrl(captureId, seconds)
  const [failedUri, setFailedUri] = useState<string | null>(null)
  const [aspect, setAspect] = useState(9 / 16)
  const [open, setOpen] = useState(false)

  if (failedUri === uri) return null

  const size = aspect < 1
    ? { width: Math.round(THUMB * aspect), height: THUMB }
    : { width: THUMB, height: Math.round(THUMB / aspect) }

  return (
    <>
      <TouchableRipple
        onPress={() => setOpen(true)}
        borderless
        style={styles.thumbTouch}
        accessibilityRole="imagebutton"
        accessibilityLabel={`Frame at ${timestamp(seconds)}. Tap to enlarge.`}
      >
        <View>
          <Image
            source={{ uri }}
            style={[size, styles.thumb, { backgroundColor: colors.surfaceVariant }]}
            contentFit="contain"
            transition={150}
            recyclingKey={uri}
            onLoad={(e) => {
              const { width, height } = e.source
              if (width > 0 && height > 0) setAspect(width / height)
            }}
            onError={() => setFailedUri(uri)}
          />
          <Surface elevation={0} style={[styles.stamp, { backgroundColor: colors.inverseSurface }]}>
            <Icon source="arrow-expand" size={12} color={colors.inverseOnSurface} />
            <Text variant="labelSmall" style={[styles.tabular, { color: colors.inverseOnSurface }]}>{timestamp(seconds)}</Text>
          </Surface>
        </View>
      </TouchableRipple>
      <FrameViewer uri={uri} visible={open} onClose={() => setOpen(false)} title={title} quote={quote} />
    </>
  )
}

/**
 * For evidence that isn't a mention — a price read off a menu board, say — a
 * small "See frame" button instead of a thumbnail, so a list of facts stays a
 * list.
 */
export function FrameLink({ captureId, seconds, title, quote }: {
  captureId: string
  seconds: number
  title: string
  quote?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        mode="outlined"
        compact
        icon="image-outline"
        onPress={() => setOpen(true)}
        accessibilityLabel={`See the frame at ${timestamp(seconds)}`}
      >
        See frame
      </Button>
      <FrameViewer
        uri={evidence.frameUrl(captureId, seconds)}
        visible={open}
        onClose={() => setOpen(false)}
        title={title}
        quote={quote}
      />
    </>
  )
}

/** A Material 3 full-screen dialog: app bar with close, the frame, the quote. */
function FrameViewer({ uri, visible, onClose, title, quote }: {
  uri: string
  visible: boolean
  onClose: () => void
  title: string
  quote?: string
}) {
  const { colors } = useAppTheme()
  const [failedUri, setFailedUri] = useState<string | null>(null)

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={[styles.viewer, { backgroundColor: colors.background }]}>
        <Appbar.Header mode="small">
          <Appbar.Action icon="close" onPress={onClose} accessibilityLabel="Close" />
          <Appbar.Content title={title} />
        </Appbar.Header>
        {failedUri === uri
          ? (
            <View style={styles.missing}>
              <Icon source="image-off-outline" size={48} color={colors.onSurfaceVariant} />
              <Text variant="bodyMedium" style={[styles.center, { color: colors.onSurfaceVariant }]}>
                This frame isn't available any more — the video it came from is no longer stored.
              </Text>
            </View>
          )
          : (
            <View style={styles.imageWrap}>
              <Image source={{ uri }} style={styles.image} contentFit="contain" onError={() => setFailedUri(uri)} />
            </View>
          )}
        {quote
          ? <Text variant="bodyLarge" style={[styles.center, styles.quote]} selectable>“{quote}”</Text>
          : null}
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  thumbTouch: { borderRadius: shape.medium, alignSelf: 'flex-start' },
  thumb: { borderRadius: shape.medium },
  stamp: {
    position: 'absolute', left: space.xs, bottom: space.xs,
    flexDirection: 'row', alignItems: 'center', gap: 3,
    paddingHorizontal: space.sm, paddingVertical: 2, borderRadius: shape.full,
  },
  tabular: { fontVariant: ['tabular-nums'] },
  viewer: { flex: 1 },
  imageWrap: { flex: 1, paddingHorizontal: space.lg },
  image: { flex: 1, width: '100%' },
  missing: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.md },
  center: { textAlign: 'center' },
  quote: { padding: space.lg, paddingBottom: space.xxl },
})
