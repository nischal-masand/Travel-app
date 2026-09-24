import { useRef, useSyncExternalStore } from 'react'
import { Button, Dialog, Portal, Text } from 'react-native-paper'
import { useAppTheme } from '../theme'

/**
 * Material 3 dialogs, callable from anywhere — including the share handler,
 * which runs outside any screen.
 *
 * This replaces Alert.alert and window.confirm. Alert's buttons do nothing on
 * react-native-web, and neither looks like the rest of the app; a Paper dialog
 * behaves the same on Android, iOS and the web.
 *
 * Requests queue: a second one waits until the first is answered, so a
 * share error can't silently replace a delete confirmation.
 */

export interface DialogAction {
  label: string
  onPress?: () => void
  /** Deletes or discards something: drawn in the error role. */
  destructive?: boolean
}

export interface DialogRequest {
  title: string
  body?: string
  /** Defaults to a single "OK". The last action is the confirming one. */
  actions?: DialogAction[]
}

let queue: DialogRequest[] = []
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

export function showDialog(request: DialogRequest) {
  queue = [...queue, request]
  emit()
}

function closeCurrent() {
  queue = queue.slice(1)
  emit()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Rendered once, inside the Paper provider. */
export function DialogHost() {
  const { colors } = useAppTheme()
  const current = useSyncExternalStore(subscribe, () => queue[0], () => queue[0])
  // Keeps the last dialog's words on screen while it fades out, rather than
  // emptying the box mid-animation.
  const shown = useRef<DialogRequest | null>(null)
  if (current) shown.current = current
  const request = current ?? shown.current
  const actions = request?.actions?.length ? request.actions : [{ label: 'OK' }]

  // Dialog styles each of its direct children, so they must be Dialog.* parts
  // and not a Fragment around them.
  return (
    <Portal>
      <Dialog visible={!!current} onDismiss={closeCurrent}>
        <Dialog.Title>{request?.title ?? ''}</Dialog.Title>
        {request?.body
          ? (
            <Dialog.Content>
              <Text variant="bodyMedium" selectable>{request.body}</Text>
            </Dialog.Content>
          )
          : null}
        <Dialog.Actions>
          {actions.map((action) => (
            <Button
              key={action.label}
              textColor={action.destructive ? colors.error : undefined}
              onPress={() => {
                closeCurrent()
                action.onPress?.()
              }}
            >
              {action.label}
            </Button>
          ))}
        </Dialog.Actions>
      </Dialog>
    </Portal>
  )
}
