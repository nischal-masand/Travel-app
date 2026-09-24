import type { ReactNode } from 'react'

/**
 * NATIVE — placeholder, owned by Agent A. Must wrap children in
 * expo-share-intent's ShareIntentProvider and handle incoming links.
 * Metro picks this file over ShareProvider.tsx on Android and iOS.
 */
export function ShareProvider({ children }: { children: ReactNode }) {
  return <>{children}</>
}
