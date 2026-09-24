import { useSyncExternalStore } from 'react'

/**
 * What the share sheet is doing, for the inbox to show.
 *
 * A link shared from Instagram lands in the inbox before the server has
 * answered, so the inbox needs to say "adding it" (the request can take a while
 * on a slow network) and then reload once it's accepted. The share handler
 * lives in the root layout and the inbox is a tab, so they talk through this
 * tiny store rather than props.
 *
 * On the web there is no share sheet; nothing ever writes here and the inbox
 * just sees the idle state.
 */
export interface ShareStatus {
  /** The link being sent to the server right now, if any. */
  sending: string | null
  /** Bumped each time the server accepts a shared link. The inbox reloads on change. */
  added: number
}

let status: ShareStatus = { sending: null, added: 0 }
const listeners = new Set<() => void>()

function set(next: ShareStatus) {
  status = next
  for (const l of listeners) l()
}

export const shareStatus = {
  sending: (url: string) => set({ ...status, sending: url }),
  added: () => set({ sending: null, added: status.added + 1 }),
  failed: () => set({ ...status, sending: null }),
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useShareStatus(): ShareStatus {
  return useSyncExternalStore(subscribe, () => status, () => status)
}
