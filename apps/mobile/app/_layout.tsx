import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { ShareProvider } from '../src/share/ShareProvider'
import { useColors } from '../src/theme'

/**
 * Root of the app. ShareProvider sits outermost so a link shared from Instagram
 * is caught however the app was launched — cold start or already running.
 */
export default function RootLayout() {
  const c = useColors()
  return (
    <ShareProvider>
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: c.surface },
          headerTintColor: c.text,
          headerShadowVisible: false,
          contentStyle: { backgroundColor: c.bg },
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="capture/[id]" options={{ title: 'Capture' }} />
      </Stack>
    </ShareProvider>
  )
}
