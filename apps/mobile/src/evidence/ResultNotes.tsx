import { useState } from 'react'
import { Card, List } from 'react-native-paper'
import type { ApiCapture, ApiRejection } from '@reel/shared'

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
  const [showDropped, setShowDropped] = useState(false)
  const frames = capture.ocrFailedFrames

  if (!capture.skippedAsrReason && frames <= 0 && rejected.length === 0) return null

  return (
    <Card mode="outlined">
      <Card.Title title="What this result may be missing" titleVariant="titleMedium" />

      {capture.skippedAsrReason
        ? (
          <Note icon="music-note-off-outline">
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
          <List.Accordion
            title={`${rejected.length} ${rejected.length === 1 ? 'item' : 'items'} dropped — the model couldn't back ${rejected.length === 1 ? 'it' : 'them'} with a quote from the reel`}
            titleNumberOfLines={3}
            left={(props) => <List.Icon {...props} icon="content-cut" />}
            expanded={showDropped}
            onPress={() => setShowDropped((v) => !v)}
          >
            {rejected.map((r) => (
              <List.Item
                key={r.id}
                title={r.reason}
                titleNumberOfLines={6}
                description={r.detail ?? undefined}
                descriptionNumberOfLines={6}
              />
            ))}
          </List.Accordion>
        )
        : null}
    </Card>
  )
}

function Note({ icon, children }: { icon: string; children: string }) {
  return (
    <List.Item
      title={children}
      titleNumberOfLines={8}
      left={(props) => <List.Icon {...props} icon={icon} />}
    />
  )
}
