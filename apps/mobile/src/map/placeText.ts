import type { ApiMapPlace, PlaceKind } from '@reel/shared'
import type { PinnedPlace } from './types'

/**
 * Words and links for a map pin, shared by the list, the web popup and the
 * native callout so all three describe a place the same way.
 */

/** The server already filters to places with coordinates; this makes it a type fact. */
export function isPinned(p: ApiMapPlace): p is PinnedPlace {
  return typeof p.lat === 'number' && Number.isFinite(p.lat)
    && typeof p.lng === 'number' && Number.isFinite(p.lng)
}

const KIND_LABELS: Record<PlaceKind, string> = {
  hotel: 'Hotel',
  restaurant: 'Restaurant',
  cafe: 'Café',
  bar: 'Bar',
  viewpoint: 'Viewpoint',
  activity: 'Activity',
  beach: 'Beach',
  museum: 'Museum',
  shop: 'Shop',
  transport: 'Transport',
  area: 'Area',
  other: 'Place',
}

export function kindLabel(kind: PlaceKind): string {
  return KIND_LABELS[kind] ?? 'Place'
}

/** "from 1 reel", "from 3 reels". */
export function reelCountLabel(p: Pick<ApiMapPlace, 'captureIds'>): string {
  const n = Math.max(1, p.captureIds.length)
  return `from ${n} reel${n === 1 ? '' : 's'}`
}

/**
 * Google's name for the place, only when it says something the reel's name
 * doesn't — "Ueno" vs "Ueno" is noise, "Ichiran" vs "Ichiran Shibuya" is not.
 */
export function googleNameIfDifferent(p: Pick<ApiMapPlace, 'name' | 'canonicalName'>): string | null {
  const google = p.canonicalName?.trim()
  if (!google) return null
  return google.toLocaleLowerCase() === p.name.trim().toLocaleLowerCase() ? null : google
}

/** The reel to open for this pin — the first one that mentioned it. */
export function firstCaptureId(p: Pick<ApiMapPlace, 'captureIds' | 'captureId'>): string {
  return p.captureIds[0] ?? p.captureId
}

export function googleMapsUrl(p: PinnedPlace): string {
  const base = `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`
  return p.googlePlaceId ? `${base}&query_place_id=${encodeURIComponent(p.googlePlaceId)}` : base
}

/**
 * Changes only when the set of pins (or where they are) changes. The map
 * refits to this, not to every refetch — returning to the tab re-fetches, and
 * that must not throw away where you had panned to.
 */
export function pinsKey(places: PinnedPlace[]): string {
  return places
    .map((p) => `${p.id}@${p.lat.toFixed(5)},${p.lng.toFixed(5)}`)
    .sort()
    .join('|')
}
