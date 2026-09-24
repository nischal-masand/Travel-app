import { useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { Button, Card, Divider, HelperText, Text, TextInput } from 'react-native-paper'
import type { ApiPlace } from '@reel/shared'
import { space, useAppTheme } from '../theme'
import { InlineError, toError } from './InlineError'

/**
 * Your verdict on a place the pipeline wouldn't vouch for: it's right, it's
 * wrong, or it's right but misspelt. Used identically in the tray and on a
 * capture, so a needs-check place behaves the same wherever you meet it.
 *
 * Rendered as the card's action area, below a divider, with the confirming
 * action last — the Material 3 order.
 *
 * Confirm and dismiss are handled by the screen (it removes or moves the card
 * straight away and puts it back if the server refuses), so their failure comes
 * in as `error`. Fixing the name waits for Google's answer, which can be:
 *   - a strong match   → the place is confirmed, and the screen moves it on;
 *   - a loose match    → still needs_check, with a new suggestion to judge;
 *   - nothing (422)    → the server's explanation, shown here as it was sent.
 */
export function ReviewActions({ place, onConfirm, onDismiss, onCorrect, error }: {
  place: ApiPlace
  onConfirm: () => void
  onDismiss: () => void
  /** Resolves with the updated place; rejects with the server's error. */
  onCorrect: (name: string) => Promise<ApiPlace>
  error?: Error | null
}) {
  const { colors } = useAppTheme()
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(place.name)
  const [busy, setBusy] = useState(false)
  const [fixError, setFixError] = useState<Error | null>(null)
  const [looseFor, setLooseFor] = useState<string | null>(null)

  async function submit() {
    const name = text.trim()
    if (!name || busy) return
    setBusy(true)
    setFixError(null)
    setLooseFor(null)
    try {
      const updated = await onCorrect(name)
      if (updated.status === 'needs_check') {
        setLooseFor(name)
        setEditing(false)
      }
    } catch (err) {
      setFixError(toError(err))
    } finally {
      setBusy(false)
    }
  }

  const notes = error || looseFor || editing
    ? (
      <Card.Content style={styles.notes}>
        {error ? <InlineError error={error} /> : null}
        {looseFor
          ? (
            <Text variant="bodySmall" style={{ color: colors.onSurfaceVariant }}>
              Google only loosely matched “{looseFor}”. Check its suggestion above, then confirm it, dismiss it, or try another name.
            </Text>
          )
          : null}
        {editing
          ? (
            <View>
              <TextInput
                mode="outlined"
                label="Correct name"
                value={text}
                onChangeText={setText}
                onSubmitEditing={() => void submit()}
                autoFocus
                autoCorrect={false}
                autoCapitalize="words"
                returnKeyType="search"
                editable={!busy}
                selectTextOnFocus
              />
              <HelperText type="info">The name as it appears on Google Maps</HelperText>
              {fixError ? <InlineError error={fixError} /> : null}
            </View>
          )
          : null}
      </Card.Content>
    )
    : null

  return (
    <View style={styles.wrap}>
      <Divider />
      {notes}
      {editing
        ? (
          <Card.Actions style={styles.actions}>
            <Button
              mode="text"
              disabled={busy}
              onPress={() => {
                setEditing(false)
                setFixError(null)
              }}
            >
              Cancel
            </Button>
            <Button mode="contained" onPress={() => void submit()} loading={busy} disabled={!text.trim() || busy}>
              Look it up
            </Button>
          </Card.Actions>
        )
        : (
          <Card.Actions style={styles.actions}>
            <Button mode="text" textColor={colors.error} onPress={onDismiss}>Dismiss</Button>
            <Button
              mode="outlined"
              onPress={() => {
                setText(place.name)
                setFixError(null)
                setEditing(true)
              }}
            >
              Fix name
            </Button>
            <Button mode="contained" onPress={onConfirm}>Confirm</Button>
          </Card.Actions>
        )}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { marginTop: space.md },
  notes: { gap: space.sm, paddingTop: space.md },
  actions: { flexWrap: 'wrap', rowGap: space.sm },
})
