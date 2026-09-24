import { useMemo, useRef, useState } from 'react'
import { Linking, StyleSheet, View, useWindowDimensions } from 'react-native'
import { router } from 'expo-router'
import { api } from '../../src/api'
import { EmptyState, ErrorBanner, Loading } from '../../src/components/ui'
import { PlaceList } from '../../src/map/PlaceList'
import { PlacesMap } from '../../src/map/PlacesMap'
import { firstCaptureId, googleMapsUrl, isPinned } from '../../src/map/placeText'
import type { PinnedPlace, PlacesMapHandle } from '../../src/map/types'
import { useAppTheme } from '../../src/theme'
import { useApi } from '../../src/useApi'

/** At or above this width the list sits beside the map instead of under it. */
const WIDE_LAYOUT = 768

/**
 * The map: only confirmed places, one pin per real place however many reels
 * mentioned it. The server does both the filtering and the collapsing, so
 * nothing unverified can reach this screen as a pin.
 */
export default function MapScreen() {
  const { colors } = useAppTheme()
  const { width } = useWindowDimensions()
  const wide = width >= WIDE_LAYOUT
  const { data, error, loading, refreshing, refresh, reload } = useApi(() => api.listMapPlaces())
  const places = useMemo(() => (data ?? []).filter(isPinned), [data])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const mapRef = useRef<PlacesMapHandle>(null)

  // A refetch can drop the selected place (e.g. it was un-confirmed elsewhere).
  const selected = selectedId !== null && places.some((p) => p.id === selectedId) ? selectedId : null

  function focusFromList(id: string) {
    setSelectedId(id)
    mapRef.current?.focus(id)
  }

  function openCapture(place: PinnedPlace) {
    router.push(`/capture/${firstCaptureId(place)}`)
  }

  function openInGoogleMaps(place: PinnedPlace) {
    Linking.openURL(googleMapsUrl(place)).catch((err: unknown) => {
      console.warn('Could not open Google Maps', err)
    })
  }

  if (loading) return <Loading />

  if (data === undefined) {
    return error ? <ErrorBanner error={error} onRetry={reload} /> : <Loading />
  }

  if (places.length === 0) {
    return (
      <View style={styles.fill}>
        {error ? <ErrorBanner error={error} onRetry={reload} /> : null}
        <EmptyState
          icon="map-marker-off-outline"
          title="No confirmed places yet"
          body="Places appear here once they're confirmed — by the pipeline or by you in the Check tab."
        />
      </View>
    )
  }

  const list = (
    <PlaceList
      places={places}
      selectedId={selected}
      onPressPlace={focusFromList}
      onOpenCapture={openCapture}
      onOpenInGoogleMaps={openInGoogleMaps}
      refreshing={refreshing}
      onRefresh={() => void refresh()}
      style={wide
        ? [styles.sideList, { borderRightColor: colors.outlineVariant }]
        : [styles.bottomList, { borderTopColor: colors.outlineVariant }]}
    />
  )

  return (
    <View style={styles.fill}>
      {/* Stale-data warning: the last good pins stay on screen underneath. */}
      {error ? <ErrorBanner error={error} onRetry={reload} /> : null}
      <View style={[styles.fill, wide && styles.row]}>
        {wide ? list : null}
        <View style={styles.fill}>
          <PlacesMap
            ref={mapRef}
            places={places}
            selectedId={selected}
            onSelect={setSelectedId}
            onOpenCapture={openCapture}
          />
        </View>
        {wide ? null : list}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  row: { flexDirection: 'row' },
  // On a phone the map dominates; the list takes what it needs, up to 40%.
  bottomList: { maxHeight: '40%', borderTopWidth: StyleSheet.hairlineWidth },
  sideList: { width: 340, borderRightWidth: StyleSheet.hairlineWidth },
})
