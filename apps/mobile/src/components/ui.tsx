import type { ReactNode } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native'
import type { ApiPlaceStatus, Confidence } from '@reel/shared'
import { font, radius, space, useColors } from '../theme'
import { ApiRequestError, ServerUnreachableError } from '../api'

/**
 * The shared building blocks. Screens compose these rather than styling their
 * own cards, badges and empty states, so work done in parallel still reads as
 * one app. Add to this file sparingly — a primitive used once is a component.
 */

export function Card({ children, style, onPress }: {
  children: ReactNode
  style?: ViewStyle
  onPress?: () => void
}) {
  const c = useColors()
  const body = (
    <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }, style]}>{children}</View>
  )
  if (!onPress) return body
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
      {body}
    </Pressable>
  )
}

/**
 * Status is the most important signal in the app, so it has exactly one
 * visual: green for vouched-for, amber for waiting on you. Nothing else in the
 * UI may use these two colours.
 */
export function StatusBadge({ status, confidence }: { status: ApiPlaceStatus; confidence?: Confidence }) {
  const c = useColors()
  const look = status === 'confirmed'
    ? { fg: c.confirmed, bg: c.confirmedBg, label: 'Confirmed' }
    : status === 'needs_check'
      ? { fg: c.needsCheck, bg: c.needsCheckBg, label: 'Check this' }
      : { fg: c.textMuted, bg: c.surfaceAlt, label: 'Dismissed' }
  return (
    <View style={[styles.badge, { backgroundColor: look.bg }]}>
      <Text style={[styles.badgeText, { color: look.fg }]}>
        {look.label}{confidence && status === 'confirmed' && confidence !== 'high' ? ` · ${confidence}` : ''}
      </Text>
    </View>
  )
}

export function Button({ label, onPress, variant = 'primary', disabled, busy }: {
  label: string
  onPress: () => void
  variant?: 'primary' | 'secondary' | 'danger'
  disabled?: boolean
  busy?: boolean
}) {
  const c = useColors()
  const look = variant === 'primary'
    ? { bg: c.accent, fg: c.accentText, border: c.accent }
    : variant === 'danger'
      ? { bg: 'transparent', fg: c.danger, border: c.border }
      : { bg: 'transparent', fg: c.text, border: c.border }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: look.bg, borderColor: look.border, opacity: disabled ? 0.4 : pressed ? 0.7 : 1 },
      ]}
    >
      {busy
        ? <ActivityIndicator color={look.fg} />
        : <Text style={[styles.buttonText, { color: look.fg }]}>{label}</Text>}
    </Pressable>
  )
}

export function EmptyState({ title, body }: { title: string; body?: string }) {
  const c = useColors()
  return (
    <View style={styles.empty}>
      <Text style={[styles.emptyTitle, { color: c.text }]}>{title}</Text>
      {body ? <Text style={[styles.emptyBody, { color: c.textMuted }]}>{body}</Text> : null}
    </View>
  )
}

/**
 * Says what actually went wrong. "Can't reach the server" and "Google found
 * nothing for that name" need different responses from the user, so errors are
 * never collapsed into a generic "something went wrong".
 */
export function ErrorBanner({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  const c = useColors()
  const detail = error instanceof ApiRequestError ? error.detail : undefined
  const title = error instanceof ServerUnreachableError ? 'Server unreachable' : error.message
  const body = error instanceof ServerUnreachableError ? error.message : detail
  return (
    <View style={[styles.banner, { backgroundColor: c.dangerBg }]}>
      <Text style={[styles.bannerTitle, { color: c.danger }]}>{title}</Text>
      {body ? <Text style={[styles.bannerBody, { color: c.danger }]}>{body}</Text> : null}
      {onRetry
        ? <Pressable onPress={onRetry} accessibilityRole="button"><Text style={[styles.bannerRetry, { color: c.danger }]}>Try again</Text></Pressable>
        : null}
    </View>
  )
}

export function Loading() {
  const c = useColors()
  return <View style={styles.empty}><ActivityIndicator color={c.accent} /></View>
}

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg, padding: space.lg, gap: space.sm },
  badge: { alignSelf: 'flex-start', paddingHorizontal: space.sm, paddingVertical: 2, borderRadius: radius.pill },
  badgeText: { fontSize: font.small, fontWeight: '600' },
  button: {
    minHeight: 44, paddingHorizontal: space.lg, borderRadius: radius.md, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
  },
  buttonText: { fontSize: font.body, fontWeight: '600' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xxl, gap: space.sm },
  emptyTitle: { fontSize: font.title, fontWeight: '600', textAlign: 'center' },
  emptyBody: { fontSize: font.body, textAlign: 'center', lineHeight: 21 },
  banner: { padding: space.md, borderRadius: radius.md, gap: space.xs, margin: space.lg },
  bannerTitle: { fontSize: font.body, fontWeight: '600' },
  bannerBody: { fontSize: font.small, lineHeight: 17 },
  bannerRetry: { fontSize: font.small, fontWeight: '700', marginTop: space.xs },
})
