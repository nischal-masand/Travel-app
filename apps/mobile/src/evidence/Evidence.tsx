import { StyleSheet, View } from 'react-native'
import { Icon, Text } from 'react-native-paper'
import type { ApiMention, SourceType } from '@reel/shared'
import { sourceLabel, timestamp } from '../format'
import { space, useAppTheme } from '../theme'
import { ClipButton } from './ClipButton'
import { EvidenceFrame, FrameLink } from './EvidenceFrame'

/**
 * How one source backed a claim: where it came from, when, and the exact words.
 * The quote is the proof, so it is always shown verbatim and never paraphrased.
 */

const SOURCE_ICON: Record<SourceType, string> = {
  transcript: 'microphone-outline',
  onScreenText: 'text-recognition',
  caption: 'text-box-outline',
}

/** "said · 0:21", "on screen · 0:53", "caption". */
export function sourceLine(sourceType: SourceType, seconds: number | null): string {
  const at = timestamp(seconds)
  return at && sourceType !== 'caption' ? `${sourceLabel(sourceType)} · ${at}` : sourceLabel(sourceType)
}

export function SourceLine({ sourceType, seconds }: { sourceType: SourceType; seconds: number | null }) {
  const { colors } = useAppTheme()
  return (
    <View style={styles.source}>
      <Icon source={SOURCE_ICON[sourceType]} size={16} color={colors.onSurfaceVariant} />
      <Text variant="labelMedium" style={[styles.tabular, { color: colors.onSurfaceVariant }]}>
        {sourceLine(sourceType, seconds)}
      </Text>
    </View>
  )
}

/**
 * The verbatim quote in curly quotes. If `highlight` (the name as the source
 * spelled it) appears inside, it is set in bold — the quote's own characters,
 * never a corrected spelling.
 */
export function Quote({ text, highlight }: { text: string; highlight?: string }) {
  const { colors } = useAppTheme()
  const at = highlight ? findIn(text, highlight) : -1
  return (
    <View style={[styles.quoteWrap, { borderLeftColor: colors.outlineVariant }]}>
      <Text variant="bodyMedium" selectable>
        “
        {at >= 0 && highlight
          ? (
            <>
              {text.slice(0, at)}
              <Text variant="bodyMedium" style={styles.mark}>{text.slice(at, at + highlight.length)}</Text>
              {text.slice(at + highlight.length)}
            </>
          )
          : text}
        ”
      </Text>
    </View>
  )
}

function findIn(text: string, needle: string): number {
  const exact = text.indexOf(needle)
  if (exact >= 0) return exact
  const loose = text.toLowerCase().indexOf(needle.toLowerCase())
  // Only trust a case-insensitive hit if lowercasing didn't change lengths.
  return loose >= 0 && text.slice(loose, loose + needle.length).toLowerCase() === needle.toLowerCase() ? loose : -1
}

/**
 * One naming of a place: the frame at that second, the source and time, the
 * quote, and — when it was spoken — the clip to hear it.
 */
export function MentionRow({ captureId, mention }: {
  captureId: string
  mention: Pick<ApiMention, 'rawName' | 'sourceQuote' | 'sourceType' | 'sourceSeconds'>
}) {
  const seconds = mention.sourceSeconds
  const line = sourceLine(mention.sourceType, seconds)
  return (
    <View style={styles.mention}>
      {seconds !== null
        ? <EvidenceFrame captureId={captureId} seconds={seconds} title={line} quote={mention.sourceQuote} />
        : null}
      <View style={styles.mentionText}>
        <SourceLine sourceType={mention.sourceType} seconds={seconds} />
        <Quote text={mention.sourceQuote} highlight={mention.rawName} />
        {mention.sourceType === 'transcript' && seconds !== null
          ? <ClipButton captureId={captureId} seconds={seconds} />
          : null}
      </View>
    </View>
  )
}

/**
 * The compact form, under a tip or a fact: source, a way to check it (hear it
 * if spoken, see the frame if it was on screen), and the quote.
 */
export function EvidenceFooter({ captureId, sourceType, seconds, quote }: {
  captureId: string
  sourceType: SourceType
  seconds: number | null
  quote: string
}) {
  const line = sourceLine(sourceType, seconds)
  return (
    <View style={styles.footer}>
      <View style={styles.footerRow}>
        <SourceLine sourceType={sourceType} seconds={seconds} />
        {sourceType === 'transcript' && seconds !== null
          ? <ClipButton captureId={captureId} seconds={seconds} />
          : null}
        {sourceType === 'onScreenText' && seconds !== null
          ? <FrameLink captureId={captureId} seconds={seconds} title={line} quote={quote} />
          : null}
      </View>
      <Quote text={quote} />
    </View>
  )
}

const styles = StyleSheet.create({
  source: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  tabular: { fontVariant: ['tabular-nums'] },
  quoteWrap: { borderLeftWidth: 2, paddingLeft: space.sm },
  mark: { fontWeight: '700' },
  // Wraps: a portrait frame sits beside its text, a landscape one above it.
  mention: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md, alignItems: 'flex-start' },
  mentionText: { flexGrow: 1, flexShrink: 1, flexBasis: 160, gap: space.sm },
  footer: { gap: space.xs },
  footerRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm },
})
