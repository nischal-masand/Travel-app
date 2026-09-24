import { StyleSheet, Text, View } from 'react-native'
import { ApiRequestError, ServerUnreachableError } from '../api'
import { font, radius, space, useColors } from '../theme'

/**
 * ErrorBanner's wording, sized to sit inside a card. The server's own words are
 * shown — "not found on Google" with its detail, "geocoding unavailable" with
 * the provider's reason — because each needs a different response from you.
 */
export function InlineError({ error }: { error: Error }) {
  const c = useColors()
  const unreachable = error instanceof ServerUnreachableError
  const title = unreachable ? 'Server unreachable' : capitalise(error.message)
  const body = unreachable ? error.message : error instanceof ApiRequestError ? error.detail : undefined
  return (
    <View style={[styles.box, { backgroundColor: c.dangerBg }]} accessibilityRole="alert">
      <Text style={[styles.title, { color: c.danger }]}>{title}</Text>
      {body ? <Text style={[styles.body, { color: c.danger }]} selectable>{body}</Text> : null}
    </View>
  )
}

export function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

function capitalise(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text
}

const styles = StyleSheet.create({
  box: { padding: space.md, borderRadius: radius.md, gap: space.xs },
  title: { fontSize: font.body, fontWeight: '600' },
  body: { fontSize: font.small, lineHeight: 17 },
})
