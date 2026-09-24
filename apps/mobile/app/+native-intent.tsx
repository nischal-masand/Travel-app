import { getShareExtensionKey } from 'expo-share-intent'

/**
 * The iOS share extension reopens the app with a link like
 * `reeltrip://dataUrl=reeltripShareKey?...`. That is not a route, so without
 * this expo-router shows its "Unmatched Route" screen before the share handler
 * gets a chance to run. Send those links to the inbox instead — the share
 * itself is still processed, because expo-share-intent reads the raw link on
 * its own.
 *
 * `+native-intent` is only consulted on native platforms, so this never loads
 * expo-share-intent into the web bundle.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    return path.includes(`dataUrl=${getShareExtensionKey()}`) ? '/' : path
  } catch {
    return '/'
  }
}
