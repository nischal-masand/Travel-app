import { useState } from 'react'
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import { Image } from 'expo-image'
import { Ionicons } from '@expo/vector-icons'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { evidence } from '../api'
import { timestamp } from '../format'
import { font, radius, space, useColors } from '../theme'

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
  const c = useColors()
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
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="imagebutton"
        accessibilityLabel={`Frame at ${timestamp(seconds)}. Tap to enlarge.`}
        style={({ pressed }) => ({ opacity: pressed ? 0.8 : 1 })}
      >
        <Image
          source={{ uri }}
          style={[size, styles.thumb, { backgroundColor: c.surfaceAlt, borderColor: c.border }]}
          contentFit="contain"
          transition={150}
          recyclingKey={uri}
          onLoad={(e) => {
            const { width, height } = e.source
            if (width > 0 && height > 0) setAspect(width / height)
          }}
          onError={() => setFailedUri(uri)}
        />
        <View style={[styles.stamp, { backgroundColor: c.surface }]}>
          <Ionicons name="expand-outline" size={11} color={c.text} />
          <Text style={[styles.stampText, { color: c.text }]}>{timestamp(seconds)}</Text>
        </View>
      </Pressable>
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
  const c = useColors()
  const [open, setOpen] = useState(false)
  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`See the frame at ${timestamp(seconds)}`}
        hitSlop={8}
        style={({ pressed }) => [styles.link, { borderColor: c.border, opacity: pressed ? 0.7 : 1 }]}
      >
        <Ionicons name="image-outline" size={13} color={c.text} />
        <Text style={[styles.linkText, { color: c.text }]}>See frame</Text>
      </Pressable>
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

function FrameViewer({ uri, visible, onClose, title, quote }: {
  uri: string
  visible: boolean
  onClose: () => void
  title: string
  quote?: string
}) {
  const c = useColors()
  const insets = useSafeAreaInsets()
  const [failedUri, setFailedUri] = useState<string | null>(null)

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View
        style={[
          styles.viewer,
          { backgroundColor: c.bg, paddingTop: insets.top + space.sm, paddingBottom: insets.bottom + space.lg },
        ]}
      >
        <View style={styles.viewerBar}>
          <Text style={[styles.viewerTitle, { color: c.textMuted }]}>{title}</Text>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" hitSlop={12}>
            <Ionicons name="close" size={26} color={c.text} />
          </Pressable>
        </View>
        {failedUri === uri
          ? (
            <View style={styles.viewerMissing}>
              <Text style={[styles.viewerMissingText, { color: c.textMuted }]}>
                This frame isn't available any more — the video it came from is no longer stored.
              </Text>
            </View>
          )
          : (
            <Pressable style={styles.viewerImageWrap} onPress={onClose} accessibilityLabel="Close">
              <Image source={{ uri }} style={styles.viewerImage} contentFit="contain" onError={() => setFailedUri(uri)} />
            </Pressable>
          )}
        {quote
          ? <Text style={[styles.viewerQuote, { color: c.text }]} selectable>“{quote}”</Text>
          : null}
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  thumb: { borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth },
  stamp: {
    position: 'absolute', left: space.xs, bottom: space.xs,
    flexDirection: 'row', alignItems: 'center', gap: 3,
    paddingHorizontal: space.xs + 2, paddingVertical: 2, borderRadius: radius.pill, opacity: 0.9,
  },
  stampText: { fontSize: 11, fontWeight: '700', fontVariant: ['tabular-nums'] },
  link: {
    flexDirection: 'row', alignItems: 'center', gap: space.xs,
    minHeight: 32, paddingHorizontal: space.md, borderRadius: radius.pill, borderWidth: 1,
  },
  linkText: { fontSize: font.small, fontWeight: '600' },
  viewer: { flex: 1, paddingHorizontal: space.lg, gap: space.md },
  viewerBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  viewerTitle: { fontSize: font.body, fontWeight: '600' },
  viewerImageWrap: { flex: 1 },
  viewerImage: { flex: 1, width: '100%' },
  viewerMissing: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl },
  viewerMissingText: { fontSize: font.body, textAlign: 'center', lineHeight: 21 },
  viewerQuote: { fontSize: font.body, lineHeight: 22, textAlign: 'center' },
})
