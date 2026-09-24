import { useEffect } from 'react'
import { StyleSheet, View } from 'react-native'
import { Button, HelperText, Icon, Text } from 'react-native-paper'
import { evidence } from '../api'
import { timestamp } from '../format'
import { space, useAppTheme } from '../theme'
import { NO_AUDIO_REASON, checkCaptureAudio, stopClipIfActive, toggleClip, useClipState } from './clipPlayer'

/**
 * "Hear it": the three seconds around a spoken name, played in place.
 *
 * Only for transcript evidence — on-screen text and captions were never spoken,
 * so a clip of them would be three seconds of unrelated audio. Never a dead
 * button: when the capture has no audio it says so instead of offering play.
 */
export function ClipButton({ captureId, seconds }: { captureId: string; seconds: number }) {
  const { colors } = useAppTheme()
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
        <Icon source="volume-off" size={16} color={colors.onSurfaceVariant} />
        <Text variant="bodySmall" style={{ color: colors.onSurfaceVariant }}>{NO_AUDIO_REASON}</Text>
      </View>
    )
  }

  const phase = clip.active === url ? clip.phase : null
  const failure = clip.failed[url]
  const playing = phase === 'playing'

  return (
    <View style={styles.wrap}>
      <Button
        compact
        mode={playing ? 'contained' : 'outlined'}
        icon={playing ? 'stop' : 'play'}
        loading={phase === 'loading'}
        onPress={() => void toggleClip(captureId, url)}
        accessibilityLabel={playing ? 'Stop the clip' : `Hear what was said at ${timestamp(seconds)}`}
      >
        {playing ? 'Stop' : phase === 'loading' ? 'Loading' : 'Hear it'}
      </Button>
      {failure ? <HelperText type="error" padding="none">{failure}</HelperText> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { gap: space.xs, alignItems: 'flex-start' },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
})
