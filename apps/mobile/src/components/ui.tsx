import type { ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import { ActivityIndicator, Appbar, Button, Chip, Icon, Surface, Text } from 'react-native-paper'
import type { ApiPlaceStatus, Confidence } from '@reel/shared'
import { ApiRequestError, ServerUnreachableError } from '../api'
import { shape, space, useAppTheme } from '../theme'

/**
 * How the app uses Material 3 for the things every screen shows: status,
 * problems, empty and loading states, and the top app bar. The components are
 * react-native-paper's; this file only fixes which roles and variants they
 * take, so a status chip or an error reads the same wherever it appears.
 */

/**
 * Status is the most important signal in the app, so it has exactly one
 * visual: the confirmed role for vouched-for, the needsCheck role for waiting
 * on you. Nothing else in the UI may use those two roles.
 */
export function StatusChip({ status, confidence }: { status: ApiPlaceStatus; confidence?: Confidence }) {
  const { colors } = useAppTheme()
  const look = status === 'confirmed'
    ? { bg: colors.confirmedContainer, fg: colors.onConfirmedContainer, icon: 'check-circle', label: 'Confirmed' }
    : status === 'needs_check'
      ? { bg: colors.needsCheckContainer, fg: colors.onNeedsCheckContainer, icon: 'map-marker-question', label: 'Check this' }
      : { bg: colors.surfaceVariant, fg: colors.onSurfaceVariant, icon: 'close-circle-outline', label: 'Dismissed' }
  const suffix = confidence && status === 'confirmed' && confidence !== 'high' ? ` · ${confidence}` : ''
  return (
    <Chip
      compact
      icon={look.icon}
      selectedColor={look.fg}
      style={{ backgroundColor: look.bg }}
      accessibilityRole="text"
    >
      {look.label}{suffix}
    </Chip>
  )
}

/**
 * A problem, in a tonal error container. Used for anything that needs the
 * user's attention and says exactly what went wrong.
 */
export function Notice({ title, body, icon = 'alert-circle-outline', action, inset = true }: {
  title: string
  body?: string
  icon?: string
  action?: { label: string; onPress: () => void }
  /** Screen-level notices sit in from the edges; ones inside a card don't. */
  inset?: boolean
}) {
  const { colors } = useAppTheme()
  const fg = colors.onErrorContainer
  return (
    <Surface
      elevation={0}
      style={[styles.notice, inset && styles.noticeInset, { backgroundColor: colors.errorContainer }]}
      accessibilityRole="alert"
    >
      <View style={styles.noticeRow}>
        <Icon source={icon} size={20} color={fg} />
        <View style={styles.flex}>
          <Text variant="titleSmall" style={{ color: fg }}>{title}</Text>
          {body ? <Text variant="bodySmall" style={{ color: fg }} selectable>{body}</Text> : null}
        </View>
      </View>
      {action
        ? <Button mode="text" compact textColor={fg} onPress={action.onPress} style={styles.noticeAction}>{action.label}</Button>
        : null}
    </Surface>
  )
}

/**
 * Says what actually went wrong. "Can't reach the server" and "Google found
 * nothing for that name" need different responses from the user, so errors are
 * never collapsed into a generic "something went wrong".
 */
export function ErrorBanner({ error, onRetry, inset }: { error: Error; onRetry?: () => void; inset?: boolean }) {
  const unreachable = error instanceof ServerUnreachableError
  return (
    <Notice
      title={unreachable ? 'Server unreachable' : capitalise(error.message)}
      body={unreachable ? error.message : error instanceof ApiRequestError ? error.detail : undefined}
      icon={unreachable ? 'lan-disconnect' : 'alert-circle-outline'}
      action={onRetry ? { label: 'Try again', onPress: onRetry } : undefined}
      inset={inset}
    />
  )
}

export function EmptyState({ icon, title, body }: { icon?: string; title: string; body?: string }) {
  const { colors } = useAppTheme()
  return (
    <View style={styles.empty}>
      {icon ? <Icon source={icon} size={48} color={colors.onSurfaceVariant} /> : null}
      <Text variant="titleMedium" style={styles.center}>{title}</Text>
      {body ? <Text variant="bodyMedium" style={[styles.center, { color: colors.onSurfaceVariant }]}>{body}</Text> : null}
    </View>
  )
}

export function Loading() {
  return <View style={styles.empty}><ActivityIndicator /></View>
}

/** The Material 3 small top app bar, for both the tabs and pushed screens. */
export function AppHeader({ title, onBack, children }: { title: string; onBack?: () => void; children?: ReactNode }) {
  return (
    <Appbar.Header mode="small">
      {onBack ? <Appbar.BackAction onPress={onBack} /> : null}
      <Appbar.Content title={title} />
      {children}
    </Appbar.Header>
  )
}

export function capitalise(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text
}

const styles = StyleSheet.create({
  flex: { flex: 1, gap: 2 },
  center: { textAlign: 'center' },
  notice: { borderRadius: shape.medium, padding: space.md, gap: space.xs },
  noticeInset: { marginHorizontal: space.lg, marginTop: space.md },
  noticeRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  noticeAction: { alignSelf: 'flex-end' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xxl, gap: space.sm },
})
