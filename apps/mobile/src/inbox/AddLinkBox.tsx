import { useState } from 'react'
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { Ionicons } from '@expo/vector-icons'
import { api } from '../api'
import { Button, ErrorBanner } from '../components/ui'
import { extractSupportedUrl } from '../share/extractUrl'
import { font, radius, space, useColors } from '../theme'

/**
 * Paste a link, get it processed. The only way in on the web, and the fallback
 * on a phone when the share sheet isn't an option.
 *
 * Whatever is typed goes to the server, which decides what it supports — if it
 * says no, its own explanation is shown, including what IS supported.
 */
export function AddLinkBox({ onAdded }: { onAdded: () => void }) {
  const c = useColors()
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
            value={text}
            onChangeText={(t) => { setText(t); if (error) setError(null); if (note) setNote(null) }}
            onSubmitEditing={() => void submit(text)}
            placeholder="Paste an Instagram, YouTube or TikTok link"
            placeholderTextColor={c.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            inputMode="url"
            returnKeyType="go"
            editable={!busy}
            accessibilityLabel="Link to a reel"
            style={[styles.input, { color: c.text, backgroundColor: c.surface, borderColor: c.border }]}
          />
          <Button label="Add" onPress={() => void submit(text)} disabled={!text.trim()} busy={busy} />
        </View>
        <Pressable
          onPress={() => void pasteFromClipboard()}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Paste link from clipboard"
          hitSlop={8}
          style={({ pressed }) => [styles.paste, { opacity: busy ? 0.4 : pressed ? 0.6 : 1 }]}
        >
          <Ionicons name="clipboard-outline" size={16} color={c.accent} />
          <Text style={[styles.pasteText, { color: c.accent }]}>Paste link from clipboard</Text>
        </Pressable>
        {note ? <Text style={[styles.note, { color: c.textMuted }]}>{note}</Text> : null}
      </View>
      {error ? <ErrorBanner error={error} /> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  box: { paddingHorizontal: space.lg, paddingTop: space.lg, gap: space.sm },
  row: { flexDirection: 'row', gap: space.sm, alignItems: 'center' },
  input: {
    flex: 1, minHeight: 44, paddingHorizontal: space.md, borderRadius: radius.md,
    borderWidth: 1, fontSize: font.body,
  },
  paste: { flexDirection: 'row', alignItems: 'center', gap: space.xs, alignSelf: 'flex-start', paddingVertical: space.xs },
  pasteText: { fontSize: font.small, fontWeight: '600' },
  note: { fontSize: font.small, lineHeight: 17 },
})
