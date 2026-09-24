import { ErrorBanner } from '../components/ui'

/**
 * ErrorBanner, sized to sit inside a card. The server's own words are shown —
 * "not found on Google" with its detail, "geocoding unavailable" with the
 * provider's reason — because each needs a different response from you.
 */
export function InlineError({ error }: { error: Error }) {
  return <ErrorBanner error={error} inset={false} />
}

export function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}
