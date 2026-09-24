import { useEffect } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { evidence } from '../api'
import { timestamp } from '../format'
import { font, radius, space, useColors } from '../theme'
import { NO_AUDIO_REASON, checkCaptureAudio, stopClipIfActive, toggleClip, useClipState } from './clipPlayer'

/**
 * "Hear it": the three seconds around a spoken name, played in place.
 *
 * Only for transcript evidence — on-screen text and captions were never spoken,
 * so a clip of them would be three seconds of unrelated audio. Never a dead
 * button: when the capture has no audio it says so instead of offering play.
 */
export function ClipButton({ captureId, seconds }: { captureId: string; seconds: number }) {
  const c = useColors()
  const url = evidence.clipUrl(captureId, seconds)
  const clip = useClipState()

  useEffect(() => {
    checkCaptureAudio(captureId, url)
  }, [captureId, url])

  // A card leaving the screen (confirmed, dismissed) takes its sound with it.
  useEffect(() => () => stopClipIfActive(url), [url])

  if (clip.audio[captureId] === 'no') {
    return (
      <View style={styles.row} accessibilityLabel={NO_AUDIO_REASON}>
        <Ionicons name="volume-mute-outline" size={14} color={c.textMuted} />
        <Text style={[styles.note, { color: c.textMuted }]}>{NO_AUDIO_REASON}</Text>
      </View>
    )
  }

  const phase = clip.active === url ? clip.phase : null
  const failure = clip.failed[url]
  const on = phase !== null
  const fg = on ? c.accentText : c.accent
  const label = phase === 'playing' ? 'Stop' : phase === 'loading' ? 'Loading' : 'Hear it'

  return (
    <View style={styles.wrap}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={phase === 'playing' ? 'Stop the clip' : `Hear what was said at ${timestamp(seconds)}`}
        accessibilityState={{ busy: phase === 'loading' }}
        onPress={() => void toggleClip(captureId, url)}
        hitSlop={8}
        style={({ pressed }) => [
          styles.pill,
          { borderColor: c.accent, backgroundColor: on ? c.accent : 'transparent', opacity: pressed ? 0.7 : 1 },
        ]}
      >
        {phase === 'loading'
          ? <ActivityIndicator size="small" color={fg} style={styles.spinner} />
          : <Ionicons name={phase === 'playing' ? 'stop' : 'play'} size={13} color={fg} />}
        <Text style={[styles.pillText, { color: fg }]}>{label}</Text>
      </Pressable>
      {failure ? <Text style={[styles.note, { color: c.danger }]}>{failure}</Text> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { gap: space.xs, alignItems: 'flex-start' },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: space.xs,
    minHeight: 32, paddingHorizontal: space.md, borderRadius: radius.pill, borderWidth: 1,
  },
  spinner: { transform: [{ scale: 0.7 }] },
  pillText: { fontSize: font.small, fontWeight: '700' },
  note: { fontSize: font.small },
})
