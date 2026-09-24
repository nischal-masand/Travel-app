import type { Ref } from 'react'
import type { ApiMapPlace } from '@reel/shared'

/**
 * The contract both map implementations meet: PlacesMap.tsx (Leaflet, web)
 * and PlacesMap.native.tsx (react-native-maps). TypeScript only ever resolves
 * the web file for callers, so both files type their props with this one
 * interface — that is what keeps the two signatures identical.
 */

/** A map place that is known to have coordinates. */
export type PinnedPlace = ApiMapPlace & { lat: number; lng: number }

export interface PlacesMapHandle {
  /** Bring one pin into view and open its popup / callout. */
  focus(id: string): void
}

export interface PlacesMapProps {
  places: PinnedPlace[]
  selectedId: string | null
  /** A pin was tapped. */
  onSelect: (id: string) => void
  /** The popup / callout was tapped through to the reel it came from. */
  onOpenCapture: (place: PinnedPlace) => void
  ref?: Ref<PlacesMapHandle>
}
