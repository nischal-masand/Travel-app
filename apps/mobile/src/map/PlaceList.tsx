import { useLayoutEffect, useRef } from 'react'
import {
  Pressable, RefreshControl, ScrollView, StyleSheet, Text, View,
  type LayoutChangeEvent, type StyleProp, type ViewStyle,
} from 'react-native'
import { Button } from '../components/ui'
import { font, radius, space, useColors } from '../theme'
import { googleNameIfDifferent, kindLabel, reelCountLabel } from './placeText'
import type { PinnedPlace } from './types'

/**
 * The places on the map as a list: name · kind · address. Tapping a row
 * focuses its pin; the selected row opens up with the actions, which is also
 * where "Open in Google Maps" lives on native (an Android callout can only
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
  const c = useColors()
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

  return (
    <ScrollView
      ref={scrollRef}
      style={[styles.list, { backgroundColor: c.surface, borderColor: c.border }, style]}
      contentContainerStyle={styles.content}
      onLayout={(e) => { viewportHeight.current = e.nativeEvent.layout.height }}
      onScroll={(e) => { offset.current = e.nativeEvent.contentOffset.y }}
      scrollEventThrottle={32}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.accent} colors={[c.accent]} />}
    >
      <Text style={[styles.header, { color: c.textMuted }]}>
        {places.length} confirmed place{places.length === 1 ? '' : 's'}
      </Text>
      {places.map((place) => {
        const selected = place.id === selectedId
        const google = selected ? googleNameIfDifferent(place) : null
        return (
          <View
            key={place.id}
            onLayout={(e) => onRowLayout(place.id, e)}
            style={[
              styles.row,
              { borderColor: selected ? c.accent : 'transparent' },
              selected && { backgroundColor: c.surfaceAlt },
            ]}
          >
            <Pressable
              onPress={() => onPressPlace(place.id)}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityHint="Shows this place on the map"
              style={({ pressed }) => [styles.rowHead, { opacity: pressed ? 0.6 : 1 }]}
            >
              <View style={[styles.dot, { backgroundColor: c.accent }]} />
              <View style={styles.rowText}>
                <Text style={[styles.name, { color: c.text }]} numberOfLines={selected ? undefined : 1}>
                  {place.name}
                </Text>
                <Text style={[styles.meta, { color: c.textMuted }]} numberOfLines={1}>
                  {selected
                    ? `${kindLabel(place.kind)} · ${reelCountLabel(place)}`
                    : [kindLabel(place.kind), place.address].filter(Boolean).join(' · ')}
                </Text>
              </View>
            </Pressable>
            {selected ? (
              <View style={styles.details}>
                {google ? <Text style={[styles.meta, { color: c.textMuted }]}>On Google as {google}</Text> : null}
                {place.address ? <Text style={[styles.address, { color: c.text }]}>{place.address}</Text> : null}
                <View style={styles.actions}>
                  <Button label="Open reel" onPress={() => onOpenCapture(place)} />
                  <Button label="Open in Google Maps" variant="secondary" onPress={() => onOpenInGoogleMaps(place)} />
                </View>
              </View>
            ) : null}
          </View>
        )
      })}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  list: { flexGrow: 0 },
  content: { paddingHorizontal: space.sm, paddingBottom: space.md },
  header: {
    fontSize: font.small, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5,
    paddingHorizontal: space.sm, paddingTop: space.md, paddingBottom: space.xs,
  },
  row: { borderRadius: radius.md, borderLeftWidth: 3 },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.sm, paddingHorizontal: space.sm },
  dot: { width: 10, height: 10, borderRadius: radius.pill },
  rowText: { flex: 1, gap: 2 },
  name: { fontSize: font.body, fontWeight: '600' },
  meta: { fontSize: font.small, lineHeight: 17 },
  address: { fontSize: font.small, lineHeight: 17 },
  details: { gap: space.xs, paddingLeft: space.sm + 10 + space.md, paddingRight: space.sm, paddingBottom: space.md },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.sm },
})
