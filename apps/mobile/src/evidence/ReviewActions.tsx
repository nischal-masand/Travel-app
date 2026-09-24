import { useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import type { ApiPlace } from '@reel/shared'
import { Button } from '../components/ui'
import { font, radius, space, useColors } from '../theme'
import { InlineError, toError } from './InlineError'

/**
 * Your verdict on a place the pipeline wouldn't vouch for: it's right, it's
 * wrong, or it's right but misspelt. Used identically in the tray and on a
 * capture, so a needs-check place behaves the same wherever you meet it.
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
  const c = useColors()
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

  return (
    <View style={[styles.wrap, { borderTopColor: c.border }]}>
      {error ? <InlineError error={error} /> : null}

      {looseFor
        ? (
          <Text style={[styles.note, { color: c.textMuted }]}>
            Google only loosely matched “{looseFor}”. Check its suggestion above, then confirm it, dismiss it, or try another name.
          </Text>
        )
        : null}

      {editing
        ? (
          <View style={styles.editor}>
            <Text style={[styles.label, { color: c.textMuted }]}>The right name, as it appears on Google Maps</Text>
            <TextInput
              value={text}
              onChangeText={setText}
              onSubmitEditing={() => void submit()}
              autoFocus
              autoCorrect={false}
              autoCapitalize="words"
              returnKeyType="search"
              editable={!busy}
              selectTextOnFocus
              placeholder="Place name"
              placeholderTextColor={c.textFaint}
              accessibilityLabel="Correct name"
              style={[styles.input, { color: c.text, backgroundColor: c.surfaceAlt, borderColor: c.border }]}
            />
            {fixError ? <InlineError error={fixError} /> : null}
            <View style={styles.row}>
              <View style={styles.cell}>
                <Button label="Look it up" onPress={() => void submit()} busy={busy} disabled={!text.trim()} />
              </View>
              <View style={styles.cell}>
                <Button
                  label="Cancel"
                  variant="secondary"
                  disabled={busy}
                  onPress={() => {
                    setEditing(false)
                    setFixError(null)
                  }}
                />
              </View>
            </View>
          </View>
        )
        : (
          <View style={styles.row}>
            <View style={styles.cell}><Button label="Confirm" onPress={onConfirm} /></View>
            <View style={styles.cell}>
              <Button
                label="Fix name"
                variant="secondary"
                onPress={() => {
                  setText(place.name)
                  setFixError(null)
                  setEditing(true)
                }}
              />
            </View>
            <View style={styles.cell}><Button label="Dismiss" variant="danger" onPress={onDismiss} /></View>
          </View>
        )}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { gap: space.md, marginTop: space.sm, paddingTop: space.md, borderTopWidth: StyleSheet.hairlineWidth },
  row: { flexDirection: 'row', gap: space.sm },
  cell: { flex: 1 },
  editor: { gap: space.sm },
  label: { fontSize: font.small, fontWeight: '600' },
  input: {
    minHeight: 44, paddingHorizontal: space.md, borderRadius: radius.md, borderWidth: 1, fontSize: font.body,
  },
  note: { fontSize: font.small, lineHeight: 17 },
})
