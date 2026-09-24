import { useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Platform, StyleSheet, Text, View } from 'react-native'
import Constants from 'expo-constants'
import MapView, { Callout, Marker, type MapMarker, type Region } from 'react-native-maps'
import { font, radius, space, useColors } from '../theme'
import { googleNameIfDifferent, kindLabel, pinsKey, reelCountLabel } from './placeText'
import type { PinnedPlace, PlacesMapProps } from './types'

/**
 * Native map: react-native-maps with the platform's default provider — Apple
 * Maps on iOS (no key needed), Google Maps on Android (key required, see
 * androidMapsKeyConfigured). Metro picks this file over PlacesMap.tsx on
 * Android and iOS, so Leaflet never enters the native bundle.
 *
 * Every pin is confirmed, so every pin is the accent colour; the green/amber
 * status colours are reserved for status.
 */

/** Span shown for a single pin: a neighbourhood, or a region for an area. */
function spanFor(place: PinnedPlace): number {
  return place.kind === 'area' ? 0.2 : 0.012
}

function regionFor(places: PinnedPlace[]): Region | undefined {
  const [only] = places
  if (!only) return undefined
  if (places.length === 1) {
    const d = spanFor(only)
    return { latitude: only.lat, longitude: only.lng, latitudeDelta: d, longitudeDelta: d }
  }
  const lats = places.map((p) => p.lat)
  const lngs = places.map((p) => p.lng)
  const minLat = Math.min(...lats)
  const maxLat = Math.max(...lats)
  const minLng = Math.min(...lngs)
  const maxLng = Math.max(...lngs)
  // 1.4x leaves room so edge pins (and their callouts) aren't flush with the
  // frame; the floor stops two pins on one street from zooming to max.
  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLng + maxLng) / 2,
    latitudeDelta: Math.max((maxLat - minLat) * 1.4, 0.01),
    longitudeDelta: Math.max((maxLng - minLng) * 1.4, 0.01),
  }
}

/**
 * Google Maps on Android crashes the whole app natively ("API key not found")
 * if the build has no key — there is no JS error to catch. So on Android the
 * map only renders when the react-native-maps config plugin was given one;
 * that plugin entry is how the key reaches the build, and it survives into
 * the runtime config (unlike android.config, which Expo strips).
 */
function androidMapsKeyConfigured(): boolean {
  const plugins = Constants.expoConfig?.plugins ?? []
  return plugins.some((entry) => {
    if (!Array.isArray(entry) || entry[0] !== 'react-native-maps') return false
    const props: unknown = entry[1]
    if (!props || typeof props !== 'object') return false
    const key = (props as { androidGoogleMapsApiKey?: unknown }).androidGoogleMapsApiKey
    return typeof key === 'string' && key.trim().length > 0
  })
}

export function PlacesMap({ places, selectedId, onSelect, onOpenCapture, ref }: PlacesMapProps) {
  const c = useColors()
  const mapRef = useRef<MapView>(null)
  const markers = useRef(new Map<string, MapMarker>())
  const [initialRegion] = useState(() => regionFor(places))
  const currentRegion = useRef<Region | undefined>(initialRegion)
  const fitKey = pinsKey(places)
  const placesRef = useRef(places)
  placesRef.current = places

  // Refit when the set of pins changes — not on every refetch, which would
  // throw away wherever you had panned to each time the tab regains focus.
  const lastFitKey = useRef(fitKey)
  useEffect(() => {
    if (lastFitKey.current === fitKey) return
    lastFitKey.current = fitKey
    const region = regionFor(placesRef.current)
    if (region) mapRef.current?.animateToRegion(region, 400)
  }, [fitKey])

  useImperativeHandle(ref, () => ({
    focus(id) {
      const place = placesRef.current.find((p) => p.id === id)
      if (!place) return
      // Zoom in if we're far out; never zoom *out* to show a pin.
      const current = currentRegion.current?.latitudeDelta ?? Infinity
      const delta = Math.min(current, place.kind === 'area' ? 0.2 : 0.02)
      mapRef.current?.animateToRegion(
        { latitude: place.lat, longitude: place.lng, latitudeDelta: delta, longitudeDelta: delta },
        350,
      )
      markers.current.get(id)?.showCallout()
    },
  }), [])

  if (Platform.OS === 'android' && !androidMapsKeyConfigured()) {
    return (
      <View style={[styles.fill, styles.unavailable, { backgroundColor: c.surfaceAlt }]}>
        <Text style={[styles.unavailableTitle, { color: c.text }]}>Map not set up on this Android build</Text>
        <Text style={[styles.unavailableBody, { color: c.textMuted }]}>
          It needs a Google Maps API key in the app config. Your confirmed places are still listed below.
        </Text>
      </View>
    )
  }

  return (
    <View style={styles.fill}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        initialRegion={initialRegion}
        onRegionChangeComplete={(region) => { currentRegion.current = region }}
      >
        {places.map((place) => (
          <Marker
            key={place.id}
            identifier={place.id}
            ref={(m) => {
              if (m) markers.current.set(place.id, m)
              else markers.current.delete(place.id)
            }}
            coordinate={{ latitude: place.lat, longitude: place.lng }}
            pinColor={c.accent}
            title={place.name}
            onPress={() => onSelect(place.id)}
            onCalloutPress={() => onOpenCapture(place)}
            zIndex={place.id === selectedId ? 1 : 0}
          >
            {/*
              `tooltip` drops the native bubble so the callout takes the app's
              colours (Android's default info window is always white). On
              Android a callout is a static snapshot with one tap target, so it
              holds the details plus "Open reel"; Google Maps lives in the list.
            */}
            <Callout tooltip>
              <CalloutBody place={place} />
            </Callout>
          </Marker>
        ))}
      </MapView>
    </View>
  )
}

function CalloutBody({ place }: { place: PinnedPlace }) {
  const c = useColors()
  const google = googleNameIfDifferent(place)
  return (
    <View style={[styles.callout, { backgroundColor: c.surface, borderColor: c.border }]}>
      <Text style={[styles.calloutTitle, { color: c.text }]} numberOfLines={2}>{place.name}</Text>
      {google
        ? <Text style={[styles.calloutSmall, { color: c.textMuted }]} numberOfLines={2}>On Google as {google}</Text>
        : null}
      {place.address
        ? <Text style={[styles.calloutBody, { color: c.text }]} numberOfLines={3}>{place.address}</Text>
        : null}
      <Text style={[styles.calloutSmall, { color: c.textMuted }]}>
        {kindLabel(place.kind)} · {reelCountLabel(place)}
      </Text>
      <Text style={[styles.calloutAction, { color: c.accent }]}>Open reel ›</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  unavailable: { alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.sm },
  unavailableTitle: { fontSize: font.body, fontWeight: '600', textAlign: 'center' },
  unavailableBody: { fontSize: font.small, lineHeight: 17, textAlign: 'center' },
  callout: {
    width: 260,
    padding: space.md,
    gap: space.xs,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: space.sm,
  },
  calloutTitle: { fontSize: font.body, fontWeight: '600' },
  calloutBody: { fontSize: font.small, lineHeight: 17 },
  calloutSmall: { fontSize: font.small, lineHeight: 17 },
  calloutAction: { fontSize: font.small, fontWeight: '700', marginTop: space.xs },
})
