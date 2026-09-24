import { type ComponentProps, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import type { ApiCapture, ApiRejection } from '@reel/shared'
import { Card } from '../components/ui'
import { font, space, useColors } from '../theme'

/**
 * Why a result may be thinner than the reel: nothing was transcribed, some
 * on-screen text couldn't be read, or the model produced items it couldn't
 * back with a quote and they were dropped. Hiding these would make a short
 * list look like a broken app — or, worse, like a complete one.
 */
export function ResultNotes({ capture, rejected }: {
  capture: Pick<ApiCapture, 'skippedAsrReason' | 'ocrFailedFrames'>
  rejected: ApiRejection[]
}) {
  const c = useColors()
  const [showDropped, setShowDropped] = useState(false)
  const frames = capture.ocrFailedFrames

  if (!capture.skippedAsrReason && frames <= 0 && rejected.length === 0) return null

  return (
    <Card>
      <Text style={[styles.title, { color: c.text }]}>What this result may be missing</Text>

      {capture.skippedAsrReason
        ? (
          <Note icon="musical-notes-outline">
            {/music/i.test(capture.skippedAsrReason)
              ? 'Nothing was transcribed: the reel plays a music track instead of its own audio, so there was no voiceover to listen to. Places here come only from the caption and on-screen text.'
              : `Nothing was transcribed: ${capture.skippedAsrReason}. Places here come only from the caption and on-screen text.`}
          </Note>
        )
        : null}

      {frames > 0
        ? (
          <Note icon="eye-off-outline">
            {`On-screen text in ${frames} ${frames === 1 ? 'frame' : 'frames'} couldn't be read (the text-reading service was unavailable), so a name shown only on screen may be missing.`}
          </Note>
        )
        : null}

      {rejected.length > 0
        ? (
          <View style={styles.dropped}>
            <Pressable
              onPress={() => setShowDropped((v) => !v)}
              accessibilityRole="button"
              accessibilityState={{ expanded: showDropped }}
              hitSlop={8}
              style={({ pressed }) => [styles.toggle, { opacity: pressed ? 0.6 : 1 }]}
            >
              <Ionicons name="cut-outline" size={16} color={c.textMuted} style={styles.icon} />
              <Text style={[styles.body, styles.toggleText, { color: c.text }]}>
                {rejected.length} {rejected.length === 1 ? 'item' : 'items'} dropped — the model couldn't back {rejected.length === 1 ? 'it' : 'them'} with a quote from the reel
              </Text>
              <Ionicons name={showDropped ? 'chevron-up' : 'chevron-down'} size={16} color={c.textMuted} />
            </Pressable>
            {showDropped
              ? (
                <View style={styles.reasons}>
                  {rejected.map((r) => (
                    <View key={r.id} style={styles.reason}>
                      <Text style={[styles.reasonText, { color: c.textMuted }]} selectable>{r.reason}</Text>
                      {r.detail ? <Text style={[styles.reasonText, { color: c.textFaint }]} selectable>{r.detail}</Text> : null}
                    </View>
                  ))}
                </View>
              )
              : null}
          </View>
        )
        : null}
    </Card>
  )
}

function Note({ icon, children }: { icon: ComponentProps<typeof Ionicons>['name']; children: string }) {
  const c = useColors()
  return (
    <View style={styles.note}>
      <Ionicons name={icon} size={16} color={c.textMuted} style={styles.icon} />
      <Text style={[styles.body, { color: c.text }]}>{children}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  title: { fontSize: font.title, fontWeight: '700' },
  note: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  icon: { marginTop: 2 },
  body: { flex: 1, fontSize: font.body, lineHeight: 21 },
  dropped: { gap: space.sm },
  toggle: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  toggleText: { fontWeight: '600' },
  reasons: { gap: space.sm, paddingLeft: space.xl },
  reason: { gap: 2 },
  reasonText: { fontSize: font.small, lineHeight: 17 },
})
