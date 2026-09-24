import 'leaflet/dist/leaflet.css'
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type CSSProperties } from 'react'
import { StyleSheet, View, useColorScheme } from 'react-native'
import { CircleMarker, MapContainer, Popup, TileLayer, useMap } from 'react-leaflet'
import {
  latLngBounds,
  type CircleMarker as LeafletCircleMarker,
  type LatLngBoundsExpression,
  type Map as LeafletMap,
} from 'leaflet'
import { font, radius, space, useColors, type Colors } from '../theme'
import {
  googleMapsUrl, googleNameIfDifferent, kindLabel, pinsKey, reelCountLabel,
} from './placeText'
import type { PinnedPlace, PlacesMapProps } from './types'

/**
 * Web map: Leaflet with OpenStreetMap tiles — free, no key. Metro picks
 * PlacesMap.native.tsx on Android and iOS, so Leaflet never enters the native
 * bundle and react-native-maps never enters this one.
 *
 * Pins are CircleMarkers rather than Leaflet's default Marker, whose icon
 * images break under bundlers. Every pin here is confirmed, so they are all
 * the accent colour — the green/amber status colours are reserved.
 */

const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
const MAP_CLASS = 'reel-places-map'
/** Never zoom closer than this when fitting several pins. */
const MAX_FIT_ZOOM = 15
const FIT_PADDING: [number, number] = [40, 40]

/** A single pin gets a zoom that shows its surroundings, not the max zoom. */
function zoomFor(place: PinnedPlace): number {
  return place.kind === 'area' ? 11 : 15
}

function initialView(places: PinnedPlace[]): { bounds: LatLngBoundsExpression; maxZoom: number } {
  const pts = places.map((p): [number, number] => [p.lat, p.lng])
  const [first] = pts
  const [only] = places
  if (places.length === 1 && first && only) return { bounds: [first, first], maxZoom: zoomFor(only) }
  return { bounds: first ? pts : [[-50, -150], [65, 160]], maxZoom: MAX_FIT_ZOOM }
}

function fitMap(map: LeafletMap, places: PinnedPlace[], animate: boolean) {
  const [only] = places
  if (!only) return
  if (places.length === 1) {
    map.setView([only.lat, only.lng], zoomFor(only), { animate })
    return
  }
  map.fitBounds(latLngBounds(places.map((p) => [p.lat, p.lng])), {
    padding: FIT_PADDING, maxZoom: MAX_FIT_ZOOM, animate,
  })
}

export function PlacesMap({ places, selectedId, onSelect, onOpenCapture, ref }: PlacesMapProps) {
  const c = useColors()
  const dark = useColorScheme() === 'dark'
  const mapRef = useRef<LeafletMap | null>(null)
  const markers = useRef(new Map<string, LeafletCircleMarker>())
  const pendingOpen = useRef<(() => void) | null>(null)
  const fitKey = pinsKey(places)

  useImperativeHandle(ref, () => ({
    focus(id) {
      const map = mapRef.current
      const marker = markers.current.get(id)
      if (!map || !marker) return
      // A second tap mid-flight replaces the first; don't open both popups.
      if (pendingOpen.current) map.off('moveend', pendingOpen.current)
      pendingOpen.current = null

      const target = marker.getLatLng()
      const place = places.find((p) => p.id === id)
      const zoom = Math.max(map.getZoom(), place ? Math.min(zoomFor(place), 14) : 14)
      const arrived = () => map.getZoom() === zoom
        && map.latLngToContainerPoint(target).distanceTo(map.latLngToContainerPoint(map.getCenter())) < 4
      if (arrived()) {
        marker.openPopup()
        return
      }
      // Open once the flight lands: the popup's own auto-pan would otherwise
      // fight the animation. The arrival check matters because a container
      // resize mid-flight (the list row expanding) also fires moveend.
      const open = () => {
        if (!arrived()) return
        map.off('moveend', open)
        pendingOpen.current = null
        marker.openPopup()
      }
      pendingOpen.current = open
      map.on('moveend', open)
      map.flyTo(target, zoom, { duration: 0.6 })
    },
  }), [places])

  // Keep the selected pin drawn above its neighbours.
  useEffect(() => {
    if (selectedId) markers.current.get(selectedId)?.bringToFront()
  }, [selectedId])

  // Only used to create the map (so the first paint is already framed);
  // <Viewport> owns the view from then on.
  const [initial] = useState(() => initialView(places))

  const css = useMemo(() => mapCss(c, dark), [c, dark])

  return (
    <View style={styles.fill}>
      <style>{css}</style>
      <MapContainer
        ref={mapRef}
        className={MAP_CLASS}
        style={containerStyle}
        bounds={initial.bounds}
        boundsOptions={{ padding: FIT_PADDING, maxZoom: initial.maxZoom }}
        worldCopyJump
      >
        <TileLayer url={TILE_URL} attribution={TILE_ATTRIBUTION} maxZoom={19} />
        <Viewport places={places} fitKey={fitKey} />
        {places.map((place) => {
          const selected = place.id === selectedId
          return (
            <CircleMarker
              key={place.id}
              ref={(m) => {
                if (m) markers.current.set(place.id, m)
                else markers.current.delete(place.id)
              }}
              center={[place.lat, place.lng]}
              radius={selected ? 11 : 8}
              pathOptions={{
                color: selected ? c.text : c.surface,
                weight: selected ? 3 : 2,
                fillColor: c.accent,
                fillOpacity: 1,
              }}
              eventHandlers={{ click: () => onSelect(place.id) }}
            >
              <Popup minWidth={220} maxWidth={280} autoPanPadding={[24, 24]}>
                <PopupBody place={place} c={c} onOpenCapture={onOpenCapture} />
              </Popup>
            </CircleMarker>
          )
        })}
      </MapContainer>
    </View>
  )
}

/**
 * Fits the map to its pins when the set of pins changes, and keeps Leaflet's
 * idea of its own size current. Leaflet only watches the window; a container
 * that resizes on its own (layout settling, a panel appearing, a hidden tab
 * becoming visible) otherwise leaves grey, untiled strips.
 */
function Viewport({ places, fitKey }: { places: PinnedPlace[]; fitKey: string }) {
  const map = useMap()
  const placesRef = useRef(places)
  placesRef.current = places
  const pendingFit = useRef(false)
  const hasFitted = useRef(false)

  const fitNow = useCallback(() => {
    const el = map.getContainer()
    if (el.clientWidth === 0 || el.clientHeight === 0) {
      // Fitting to a 0px box picks a nonsense zoom; wait until we have a size.
      pendingFit.current = true
      return
    }
    pendingFit.current = false
    map.invalidateSize({ pan: false })
    fitMap(map, placesRef.current, hasFitted.current)
    hasFitted.current = true
  }, [map])

  useEffect(() => {
    fitNow()
  }, [fitKey, fitNow])

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (pendingFit.current) fitNow()
      // Keeps the centre where it was, so a focused pin stays in view as the
      // list below grows or shrinks.
      else map.invalidateSize()
    })
    observer.observe(map.getContainer())
    return () => observer.disconnect()
  }, [map, fitNow])

  return null
}

/**
 * Leaflet renders popup content with react-dom into its own DOM, and stops
 * mousedown/touchstart from bubbling out of the popup — which is what
 * react-native-web's Pressable listens for. Plain elements with onClick work,
 * so the popup is written in DOM terms.
 */
function PopupBody({ place, c, onOpenCapture }: {
  place: PinnedPlace
  c: Colors
  onOpenCapture: (place: PinnedPlace) => void
}) {
  const google = googleNameIfDifferent(place)
  const muted: CSSProperties = { color: c.textMuted, fontSize: font.small, lineHeight: '17px' }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space.xs }}>
      <div style={{ color: c.text, fontSize: font.title, fontWeight: 600, lineHeight: '22px' }}>{place.name}</div>
      {google ? <div style={muted}>On Google as {google}</div> : null}
      {place.address ? <div style={{ ...muted, color: c.text }}>{place.address}</div> : null}
      <div style={muted}>{kindLabel(place.kind)} · {reelCountLabel(place)}</div>
      <div style={{ display: 'flex', gap: space.sm, marginTop: space.sm, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={() => onOpenCapture(place)}
          style={{
            background: c.accent, color: c.accentText, border: `1px solid ${c.accent}`,
            borderRadius: radius.md, padding: `${space.xs + 2}px ${space.md}px`,
            fontSize: font.small, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer',
          }}
        >
          Open reel
        </button>
        <a
          href={googleMapsUrl(place)}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            color: c.text, border: `1px solid ${c.border}`, borderRadius: radius.md,
            padding: `${space.xs + 2}px ${space.md}px`, fontSize: font.small, fontWeight: 600,
            textDecoration: 'none',
          }}
        >
          Google Maps ↗
        </a>
      </div>
    </div>
  )
}

/** Theme Leaflet's chrome (popup, controls, background) to match the app. */
function mapCss(c: Colors, dark: boolean): string {
  const scope = `.${MAP_CLASS}`
  return `
${scope}.leaflet-container {
  background: ${c.surfaceAlt};
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
${scope} .leaflet-popup-content-wrapper, ${scope} .leaflet-popup-tip {
  background: ${c.surface};
  color: ${c.text};
  border: 1px solid ${c.border};
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
}
${scope} .leaflet-popup-content-wrapper { border-radius: ${radius.lg}px; }
${scope} .leaflet-popup-content { margin: ${space.md}px ${space.xl}px ${space.md}px ${space.lg}px; }
${scope} a.leaflet-popup-close-button { color: ${c.textMuted}; }
${scope} .leaflet-bar a { background: ${c.surface}; color: ${c.text}; border-bottom-color: ${c.border}; }
${scope} .leaflet-control-attribution { background: ${c.surface}cc; color: ${c.textMuted}; }
${scope} .leaflet-control-attribution a { color: ${c.accent}; }
${dark ? `${scope} .leaflet-tile-pane { filter: invert(1) hue-rotate(180deg) brightness(0.9) contrast(0.9); }` : ''}
`
}

// Absolutely filling a relatively positioned View gives Leaflet a definite
// height; a percentage height inside a flex child can resolve to 0px.
const containerStyle: CSSProperties = { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }

const styles = StyleSheet.create({
  fill: { flex: 1, position: 'relative', overflow: 'hidden' },
})
