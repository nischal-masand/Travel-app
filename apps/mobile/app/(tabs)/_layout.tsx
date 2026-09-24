import { Tabs } from 'expo-router/js-tabs'
import { getHeaderTitle } from 'expo-router/react-navigation'
import { BottomNavigation, Icon } from 'react-native-paper'
import { AppHeader } from '../../src/components/ui'

/** Material 3 icons fill in when their destination is active: [active, inactive]. */
const ICONS: Record<string, [string, string]> = {
  index: ['inbox', 'inbox-outline'],
  tray: ['map-marker-question', 'map-marker-question-outline'],
  map: ['map', 'map-outline'],
}

/**
 * The three destinations, on a Material 3 navigation bar (Paper's
 * BottomNavigation.Bar, standing in for the navigator's own tab bar).
 */
export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        header: ({ options, route }) => <AppHeader title={getHeaderTitle(options, route.name)} />,
      }}
      tabBar={({ navigation, state, descriptors, insets }) => (
        <BottomNavigation.Bar
          navigationState={state}
          safeAreaInsets={insets}
          onTabPress={({ route, preventDefault }) => {
            const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true })
            if (event.defaultPrevented) preventDefault()
            else navigation.navigate(route.name, route.params)
          }}
          renderIcon={({ route, focused, color }) => {
            const icons = ICONS[route.name]
            return icons ? <Icon source={focused ? icons[0] : icons[1]} color={color} size={24} /> : null
          }}
          getLabelText={({ route }) => descriptors[route.key]?.options.title ?? route.name}
        />
      )}
    >
      <Tabs.Screen name="index" options={{ title: 'Inbox' }} />
      <Tabs.Screen name="tray" options={{ title: 'Check' }} />
      <Tabs.Screen name="map" options={{ title: 'Map' }} />
    </Tabs>
  )
}
