import type { ReactNode } from 'react'

/**
 * Web (and the type-checking default). There is no share sheet on the web, so
 * this is a passthrough; the web inbox offers a paste-a-link box instead.
 * Metro picks ShareProvider.native.tsx on Android and iOS.
 */
export function ShareProvider({ children }: { children: ReactNode }) {
  return <>{children}</>
}
