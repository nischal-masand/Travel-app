import { createHash } from 'node:crypto'
import type { CaptureResult, EvidenceBundle, Fact, Place, PlaceKind, Tip } from '@reel/shared'
import { CaptureResult as CaptureResultSchema } from '@reel/shared'
import { interpret, type ModelCall, type OnRetry, type Profile } from './interpret.ts'
import { verifyMentions, verifyQuotes, type Rejection } from './verify.ts'
import { attachToClusters, clusterMentions, samePlace, type Cluster } from './reconcile.ts'
import { geocode, locationFrom, type GeocodeHit, type GeocodeOpts } from './geocode.ts'

/**
 * STAGE B + C — evidence in, verified places out.
 *
 * The order matters and is the whole design:
 *   B1 interpret   — a model reads ONE source at a time and quotes it
 *   B2 verify      — code drops anything whose quote isn't really there
 *   B3 reconcile   — three witnesses' spellings collapse to one place
 *   C  geocode     — the place either exists in the world, or it doesn't
 *
 * Two independent gates, and neither is a polite request to a model.
 */

export type Progress = (step: string, detail?: string) => void

export interface ExtractOpts {
  profile?: Profile
  geocode?: GeocodeOpts | false
  onProgress?: Progress
  onRetry?: OnRetry
  /** Replace the model call — for running the whole stage offline in tests. */
  interpretCall?: ModelCall
}

/**
 * Google's own labels for places that CONTAIN a trip rather than being a stop
 * on it. Checked against the live API: "Japan" is `country`, "Tokyo" and "Bali"
 * are `administrative_area_level_1`. Pinning them put a dot in the middle of a
 * country on the map and a "confirmed place" in the tray that nobody can visit.
 *
 * `locality` is deliberately NOT here. Kyoto, Ubud and Shinjuku all come back as
 * locality, and in a multi-city trip those are real stops — dropping them would
 * throw away the itinerary's skeleton.
 */
const REGION_TYPES = new Set(['country', 'administrative_area_level_1'])

export function isRegion(types: string[] | undefined): boolean {
  return (types ?? []).some((t) => REGION_TYPES.has(t))
}

/**
 * Google's own classification of a place it confirmed exists beats asking a
 * model to guess a category. So `kind` is never model-supplied: it is read off
 * the verified record, and an unresolved place stays 'other' rather than
 * borrowing a confidence the pipeline has not earned.
 */
const TYPE_TO_KIND: Array<[RegExp, PlaceKind]> = [
  [/^(lodging|hotel|motel|hostel|resort|guest_house|campground|rv_park)$/, 'hotel'],
  [/^(restaurant|meal_takeaway|meal_delivery|food)$/, 'restaurant'],
  [/^(cafe|coffee_shop|bakery|tea_house)$/, 'cafe'],
  [/^(bar|night_club|pub|liquor_store|wine_bar)$/, 'bar'],
  [/^(beach|natural_feature)$/, 'beach'],
  [/^(museum|art_gallery|aquarium|zoo|library)$/, 'museum'],
  [/^(tourist_attraction|amusement_park|park|hiking_area|national_park|scenic|point_of_interest_viewpoint)$/, 'viewpoint'],
  [/^(store|shopping_mall|clothing_store|book_store|market|department_store|convenience_store)$/, 'shop'],
  [/^(train_station|subway_station|bus_station|airport|transit_station|ferry_terminal)$/, 'transport'],
  [/^(locality|sublocality|administrative_area|neighborhood|political)$/, 'area'],
  [/^(spa|gym|travel_agency|tour_agency|casino|movie_theater|stadium)$/, 'activity'],
]

export function kindFromTypes(types: string[] | undefined): PlaceKind {
  for (const type of types ?? []) {
    for (const [pattern, kind] of TYPE_TO_KIND) {
      if (pattern.test(type)) return kind
    }
  }
  return 'other'
}

/** Stable per-capture id, so re-running a capture doesn't churn place ids. */
function placeIdFor(captureId: string, name: string): string {
  return createHash('sha1').update(`${captureId}:${name.toLowerCase()}`).digest('hex').slice(0, 12)
}

export async function extract(
  bundle: EvidenceBundle,
  opts: ExtractOpts = {},
): Promise<CaptureResult> {
  const { profile = 'travel', onProgress = () => {}, onRetry } = opts

  // --- B1: one model call per source, sourceType stamped in code -------------
  onProgress('interpret', 'reading each source separately')
  const output = await interpret(bundle, profile, onRetry, opts.interpretCall)
  onProgress('interpret', `${output.mentions.length} mentions, ${output.tips.length} tips, ${output.facts.length} facts`)

  // --- B2: the guard --------------------------------------------------------
  const mentions = verifyMentions(output.mentions, bundle)
  const tips = verifyQuotes(output.tips, bundle)
  const facts = verifyQuotes(output.facts, bundle)
  const rejected: Rejection[] = [...mentions.rejected, ...tips.rejected, ...facts.rejected]

  if (rejected.length) {
    // Loud on purpose. A model inventing places is the failure this pipeline
    // exists to prevent, so it should never pass silently even when caught.
    onProgress('verify', `DROPPED ${rejected.length} unquotable item(s) — ${rejected[0]!.reason}`)
  } else {
    onProgress('verify', 'every item traced to its evidence')
  }

  // --- B3: three witnesses, one place ---------------------------------------
  const clusters = clusterMentions(mentions.kept)
  const tipsByCluster = attachToClusters(tips.kept, clusters)
  // Facts carry no `aboutPlace` — rightly, since that would be the model
  // asserting a link rather than showing one. So they attach by evidence
  // instead: a fact belongs to a place when its own quote names that place.
  const factsByCluster = attachByQuote(facts.kept, clusters)
  onProgress('reconcile', `${mentions.kept.length} mentions → ${clusters.length} place(s)`)

  // --- C: does it exist? ----------------------------------------------------
  const places: Place[] = []
  const generalTips = [...tipsByCluster.unattached]
  const generalFacts = [...factsByCluster.unattached]
  // Regions become context rather than pins. Most specific wins: "Tokyo" says
  // more about a trip than "Japan" does.
  let region: { name: string; level: number } | null = null

  for (const cluster of clusters) {
    let hit: GeocodeHit | null = null

    if (opts.geocode !== false) {
      hit = await geocode(cluster.name, { destination: output.destination, ...opts.geocode }, onRetry)
    }

    const clusterTips = tipsByCluster.byCluster.get(cluster) ?? []
    const clusterFacts = factsByCluster.byCluster.get(cluster) ?? []

    // Only a CONFIDENT match may reclassify a mention as a region. A loose one
    // stays a place for you to judge, rather than silently disappearing.
    const confident = hit !== null && (hit.match === 'exact' || hit.match === 'strong')
    if (confident && isRegion(hit!.types)) {
      const level = hit!.types!.includes('administrative_area_level_1') ? 1 : 0
      if (!region || level > region.level) region = { name: hit!.canonicalName, level }
      // Advice about the region is advice about the trip — keep it, don't drop it.
      generalTips.push(...clusterTips)
      generalFacts.push(...clusterFacts)
      continue
    }

    places.push(buildPlace(bundle, cluster, hit, { tips: clusterTips, facts: clusterFacts }))
  }

  const confirmed = places.filter((p) => p.status === 'confirmed').length
  onProgress('geocode', `${confirmed} confirmed, ${places.length - confirmed} need your check`
    + (region ? ` · region: ${region.name}` : ''))

  return CaptureResultSchema.parse({
    captureId: bundle.captureId,
    profile,
    // The model's reading of the destination wins when it has one; otherwise
    // the region the reel actually named is the best statement of where it is.
    destination: output.destination ?? region?.name ?? null,
    places,
    generalTips,
    generalFacts,
    // Kept rather than discarded: when a capture comes back thinner than the
    // reel looked, this is the only way to tell "nothing was said" apart from
    // "the model said it but could not back it up".
    rejected: rejected.map((r) => ({ reason: `${r.reason} [${r.sourceType}] "${r.quote.slice(0, 80)}"`, item: r.item })),
  })
}

/**
 * Attach facts to the place their quote actually mentions.
 *
 * "entry is 200k IDR" on its own belongs to the capture, not to whichever place
 * happened to be nearest in the list — guessing an owner would put a price on a
 * place nobody quoted a price for.
 */
function attachByQuote<T extends { sourceQuote: string }>(
  items: T[],
  clusters: Cluster[],
): { byCluster: Map<Cluster, T[]>; unattached: T[] } {
  const byCluster = new Map<Cluster, T[]>(clusters.map((c) => [c, []]))
  const unattached: T[] = []

  for (const item of items) {
    const words = item.sourceQuote.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
    const owner = clusters.find((c) =>
      [c.name, ...c.mentions.map((m) => m.rawName)].some((name) => {
        const n = name.split(/\s+/).length
        // Compare the name against every same-length window of the quote, so a
        // two-word place is found inside a longer sentence.
        return words.some((_, i) => samePlace(name, words.slice(i, i + n).join(' ')))
      }))

    if (owner) byCluster.get(owner)!.push(item)
    else unattached.push(item)
  }

  return { byCluster, unattached }
}

function buildPlace(
  bundle: EvidenceBundle,
  cluster: Cluster,
  hit: GeocodeHit | null,
  extras: { tips: Tip[]; facts: Fact[] },
): Place {
  const location = locationFrom(cluster, hit)
  return {
    id: placeIdFor(bundle.captureId, cluster.name),
    name: cluster.name,
    kind: kindFromTypes(hit?.types),
    // Deliberately not synthesised. A one-line "why go" would be the model's
    // prose rather than the creator's, and the quoted tips below already say it
    // in the words someone actually used.
    whyGo: null,
    timeNeeded: null,
    bestTime: null,
    mentions: cluster.mentions,
    facts: extras.facts,
    tips: extras.tips,
    ...location,
  }
}
