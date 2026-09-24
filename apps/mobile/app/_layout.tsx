import { Stack, ThemeProvider } from 'expo-router'
import { getHeaderTitle } from 'expo-router/react-navigation'
import { StatusBar } from 'expo-status-bar'
import { PaperProvider } from 'react-native-paper'
import { AppHeader } from '../src/components/ui'
import { DialogHost } from '../src/components/dialogs'
import { ShareProvider } from '../src/share/ShareProvider'
import { navigationTheme, useBuildTheme } from '../src/theme'

/**
 * Root of the app. The Material 3 theme wraps everything, including the share
 * handler, so a problem with a shared link can be shown as a Material dialog.
 * ShareProvider sits outside the navigator so a link shared from Instagram is
 * caught however the app was launched — cold start or already running.
 */
export default function RootLayout() {
  const theme = useBuildTheme()
  return (
    <PaperProvider theme={theme}>
      <ThemeProvider value={navigationTheme(theme)}>
        <ShareProvider>
          <StatusBar style="auto" />
          <Stack
            screenOptions={{
              header: ({ options, route, back, navigation }) => (
                <AppHeader
                  title={getHeaderTitle(options, route.name)}
                  onBack={back ? navigation.goBack : undefined}
                />
              ),
              contentStyle: { backgroundColor: theme.colors.background },
            }}
          >
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="capture/[id]" options={{ title: 'Capture' }} />
          </Stack>
          <DialogHost />
        </ShareProvider>
      </ThemeProvider>
    </PaperProvider>
  )
}
