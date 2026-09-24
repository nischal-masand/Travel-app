import { useState } from 'react'
import { Platform, StyleSheet, View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { Button, HelperText, TextInput } from 'react-native-paper'
import { api } from '../api'
import { ErrorBanner } from '../components/ui'
import { extractSupportedUrl } from '../share/extractUrl'
import { space } from '../theme'

/**
 * Paste a link, get it processed. The only way in on the web, and the fallback
 * on a phone when the share sheet isn't an option.
 *
 * Whatever is typed goes to the server, which decides what it supports — if it
 * says no, its own explanation is shown, including what IS supported.
 */
export function AddLinkBox({ onAdded }: { onAdded: () => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [note, setNote] = useState<string | null>(null)

  async function submit(raw: string) {
    const trimmed = raw.trim()
    if (!trimmed || busy) return
    // Someone may paste Instagram's whole share text ("Check out this reel
    // https://..."); send just the link. If there's no recognisable link, send
    // it as typed and let the server say why not.
    const url = extractSupportedUrl({ text: trimmed }) ?? trimmed
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      await api.createCapture(url)
      setText('')
      onAdded()
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      setBusy(false)
    }
  }

  // The clipboard is read only here, when the user taps — never on mount. iOS
  // shows a "pasted from" banner on every read, and silently reading what
  // someone copied is invasive.
  async function pasteFromClipboard() {
    setError(null)
    setNote(null)
    let copied: string
    try {
      copied = await Clipboard.getStringAsync()
    } catch {
      setNote(Platform.OS === 'web'
        ? "Your browser didn't let Reel Trip read the clipboard. Paste into the box instead (Ctrl+V or ⌘V)."
        : "Couldn't read the clipboard. Paste into the box instead.")
      return
    }
    const url = extractSupportedUrl({ text: copied })
    if (!url) {
      setNote(copied.trim()
        ? "What you copied isn't an Instagram, YouTube or TikTok link."
        : 'Your clipboard is empty. Copy the link from the post first.')
      return
    }
    setText(url)
    await submit(url)
  }

  return (
    <View>
      <View style={styles.box}>
        <View style={styles.row}>
          <TextInput
            mode="outlined"
            label="Reel link"
            placeholder="Instagram, YouTube or TikTok"
            value={text}
            onChangeText={(t) => { setText(t); if (error) setError(null); if (note) setNote(null) }}
            onSubmitEditing={() => void submit(text)}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            inputMode="url"
            returnKeyType="go"
            editable={!busy}
            accessibilityLabel="Link to a reel"
            style={styles.input}
          />
          <Button mode="contained" onPress={() => void submit(text)} disabled={!text.trim() || busy} loading={busy} style={styles.add}>
            Add
          </Button>
        </View>
        <Button
          mode="text"
          icon="content-paste"
          compact
          onPress={() => void pasteFromClipboard()}
          disabled={busy}
          style={styles.paste}
        >
          Paste link from clipboard
        </Button>
        {note ? <HelperText type="info" padding="none">{note}</HelperText> : null}
      </View>
      {error ? <ErrorBanner error={error} /> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  box: { paddingHorizontal: space.lg, paddingTop: space.md, gap: space.xs },
  row: { flexDirection: 'row', gap: space.sm, alignItems: 'center' },
  input: { flex: 1 },
  // The outlined field reserves 6dp above its box for the floating label.
  add: { marginTop: 6 },
  paste: { alignSelf: 'flex-start' },
})
