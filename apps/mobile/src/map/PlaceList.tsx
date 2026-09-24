import { useLayoutEffect, useRef } from 'react'
import {
  RefreshControl, ScrollView, StyleSheet, View,
  type LayoutChangeEvent, type StyleProp, type ViewStyle,
} from 'react-native'
import { Button, List, Text } from 'react-native-paper'
import { shape, space, useAppTheme } from '../theme'
import { googleNameIfDifferent, kindLabel, reelCountLabel } from './placeText'
import type { PinnedPlace } from './types'

/**
 * The places on the map as a Material 3 list: name · kind · address. Tapping a
 * row focuses its pin; the selected row opens up with the actions, which is
 * also where "Open in Google Maps" lives on native (an Android callout can only
 * have one tap target).
 */
export function PlaceList({
  places, selectedId, onPressPlace, onOpenCapture, onOpenInGoogleMaps, refreshing, onRefresh, style,
}: {
  places: PinnedPlace[]
  selectedId: string | null
  onPressPlace: (id: string) => void
  onOpenCapture: (place: PinnedPlace) => void
  onOpenInGoogleMaps: (place: PinnedPlace) => void
  refreshing: boolean
  onRefresh: () => void
  style?: StyleProp<ViewStyle>
}) {
  const { colors } = useAppTheme()
  const scrollRef = useRef<ScrollView>(null)
  const offset = useRef(0)
  const viewportHeight = useRef(0)
  // When a pin is tapped on the map, bring its row into view once it has
  // expanded — which is when its onLayout reports the new size.
  const pendingReveal = useRef<string | null>(null)
  useLayoutEffect(() => {
    pendingReveal.current = selectedId
  }, [selectedId])

  function onRowLayout(id: string, e: LayoutChangeEvent) {
    if (pendingReveal.current !== id) return
    pendingReveal.current = null
    const { y, height } = e.nativeEvent.layout
    const top = offset.current
    const bottom = top + viewportHeight.current
    if (y < top) {
      scrollRef.current?.scrollTo({ y, animated: true })
    } else if (y + height > bottom) {
      scrollRef.current?.scrollTo({ y: Math.min(y, y + height - viewportHeight.current), animated: true })
    }
  }

  // The caller's size limits go on a wrapper, never on the ScrollView: on the
  // web a ScrollView with a RefreshControl applies its style twice, nested, so
  // a maxHeight of 40% became 40% of 40% and the list showed one row.
  return (
    <View style={[{ backgroundColor: colors.surfaceContainerLow }, style]}>
      <ScrollView
        ref={scrollRef}
        style={styles.list}
        contentContainerStyle={styles.content}
        onLayout={(e) => { viewportHeight.current = e.nativeEvent.layout.height }}
        onScroll={(e) => { offset.current = e.nativeEvent.contentOffset.y }}
        scrollEventThrottle={32}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.primary}
            colors={[colors.primary]}
            progressBackgroundColor={colors.surfaceContainerHigh}
          />
        }
      >
        <List.Subheader>
          {`${places.length} confirmed place${places.length === 1 ? '' : 's'}`}
        </List.Subheader>
        {places.map((place) => {
          const selected = place.id === selectedId
          const google = selected ? googleNameIfDifferent(place) : null
          return (
            <View
              key={place.id}
              onLayout={(e) => onRowLayout(place.id, e)}
              style={[styles.row, selected && { backgroundColor: colors.secondaryContainer }]}
            >
              <List.Item
                title={place.name}
                titleNumberOfLines={selected ? 3 : 1}
                description={selected
                  ? `${kindLabel(place.kind)} · ${reelCountLabel(place)}`
                  : [kindLabel(place.kind), place.address].filter(Boolean).join(' · ')}
                descriptionNumberOfLines={1}
                left={(props) => <List.Icon {...props} icon={selected ? 'map-marker' : 'map-marker-outline'} />}
                onPress={() => onPressPlace(place.id)}
                accessibilityState={{ selected }}
                accessibilityHint="Shows this place on the map"
              />
              {selected
                ? (
                  <View style={styles.details}>
                    {google
                      ? <Text variant="bodySmall" style={{ color: colors.onSecondaryContainer }}>On Google as {google}</Text>
                      : null}
                    {place.address
                      ? <Text variant="bodySmall" style={{ color: colors.onSecondaryContainer }} selectable>{place.address}</Text>
                      : null}
                    <View style={styles.actions}>
                      <Button mode="contained" icon="play-box-outline" onPress={() => onOpenCapture(place)}>Open reel</Button>
                      <Button mode="outlined" icon="open-in-new" onPress={() => onOpenInGoogleMaps(place)}>Google Maps</Button>
                    </View>
                  </View>
                )
                : null}
            </View>
          )
        })}
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  list: { flexGrow: 0, flexShrink: 1 },
  content: { paddingHorizontal: space.sm, paddingBottom: space.md },
  row: { borderRadius: shape.large, overflow: 'hidden' },
  // Lines the details up with the list item's text, past its leading icon.
  details: { gap: space.xs, paddingLeft: 56, paddingRight: space.lg, paddingBottom: space.md },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.sm },
})
