import type { ConfigContext, ExpoConfig } from 'expo/config'

/**
 * app.json holds the static config; this adds what must not live in git.
 *
 * On Android, react-native-maps needs a Google Maps SDK key. That key ends up
 * inside the APK anyway, but it still does not belong in a public repository,
 * where anyone could lift it and spend against your billing account. So it comes
 * from GOOGLE_MAPS_ANDROID_API_KEY at build time — set locally, or as an EAS
 * environment variable for cloud builds.
 *
 * Without it the plugin is simply not added, and the Map tab shows a notice
 * instead of the map (a missing key crashes Google Maps natively and
 * uncatchably, so the screen checks for this plugin entry before rendering).
 * iOS uses Apple Maps and needs no key.
 */
export default ({ config }: ConfigContext): ExpoConfig => {
  const mapsKey = process.env.GOOGLE_MAPS_ANDROID_API_KEY?.trim()

  return {
    ...(config as ExpoConfig),
    plugins: [
      ...(config.plugins ?? []),
      ...(mapsKey ? [['react-native-maps', { androidGoogleMapsApiKey: mapsKey }] as [string, unknown]] : []),
    ],
  }
}
