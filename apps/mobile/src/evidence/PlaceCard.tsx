import type { ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import type { ApiFact, ApiMention, ApiPlace, ApiPlaceStatus, ApiTip, PlaceKind, TipKind } from '@reel/shared'
import { Card, StatusBadge } from '../components/ui'
import { font, radius, space, useColors } from '../theme'
import { EvidenceFooter, MentionRow } from './Evidence'

/**
 * A place and everything behind it: what Google knows (or only suggests), every
 * moment the reel named it, and the tips and facts attached to it.
 */

export type PlaceWithEvidence = ApiPlace & {
  mentions: ApiMention[]
  tips?: ApiTip[]
  facts?: ApiFact[]
}

const KIND_LABEL: Record<PlaceKind, string | null> = {
  hotel: 'Hotel', restaurant: 'Restaurant', cafe: 'Café', bar: 'Bar', viewpoint: 'Viewpoint',
  activity: 'Activity', beach: 'Beach', museum: 'Museum', shop: 'Shop', transport: 'Transport',
  area: 'Area', other: null,
}

export function PlaceCard({ place, status = place.status, from, children }: {
  place: PlaceWithEvidence
  /** Overrides place.status while a verdict is in flight. */
  status?: ApiPlaceStatus
  /** "from @author" — where this place came from, when not already obvious. */
  from?: { label: string; onPress: () => void }
  /** Actions, e.g. confirm / dismiss / fix name. */
  children?: ReactNode
}) {
  const c = useColors()
  const kind = KIND_LABEL[place.kind]
  const tips = place.tips ?? []
  const facts = place.facts ?? []

  return (
    <Card style={status === 'dismissed' ? styles.dismissed : undefined}>
      <View style={styles.titleRow}>
        <Text style={[styles.name, { color: c.text }]} selectable>{place.name}</Text>
        <StatusBadge status={status} confidence={place.confidence} />
      </View>

      {kind || from
        ? (
          <View style={styles.meta}>
            {kind ? <Text style={[styles.metaText, { color: c.textMuted }]}>{kind}</Text> : null}
            {kind && from ? <Text style={[styles.metaText, { color: c.textFaint }]}>·</Text> : null}
            {from
              ? (
                <Pressable
                  onPress={from.onPress}
                  accessibilityRole="link"
                  hitSlop={8}
                  style={({ pressed }) => [styles.from, { opacity: pressed ? 0.6 : 1 }]}
                >
                  <Text style={[styles.metaText, styles.fromText, { color: c.accent }]}>{from.label}</Text>
                  <Ionicons name="chevron-forward" size={13} color={c.accent} />
                </Pressable>
              )
              : null}
          </View>
        )
        : null}

      <GoogleMatch place={place} status={status} />

      {place.mentions.length > 0
        ? (
          <Section title={place.mentions.length === 1 ? 'Where the reel names it' : `Where the reel names it · ${place.mentions.length}`}>
            {sortMentions(place.mentions).map((m) => (
              <MentionRow key={m.id} captureId={place.captureId} mention={m} />
            ))}
          </Section>
        )
        : null}

      {tips.length > 0
        ? <Section title="Tips"><TipList tips={tips} captureId={place.captureId} /></Section>
        : null}

      {facts.length > 0
        ? <Section title="Facts"><FactList facts={facts} captureId={place.captureId} /></Section>
        : null}

      {children}
    </Card>
  )
}

/** In the order you'd meet them watching the reel; the caption, untimed, last. */
function sortMentions(mentions: ApiMention[]): ApiMention[] {
  const at = (m: ApiMention) => m.sourceSeconds ?? Number.MAX_SAFE_INTEGER
  return [...mentions].sort((a, b) => at(a) - at(b))
}

/**
 * What Google says. For a confirmed place that is a fact; for one waiting on
 * you it is only a suggestion, and is worded as one — confirming the card is
 * what turns it into a pin.
 */
function GoogleMatch({ place, status }: { place: ApiPlace; status: ApiPlaceStatus }) {
  const c = useColors()
  const differs = !!place.canonicalName && normalise(place.canonicalName) !== normalise(place.name)

  if (status === 'confirmed') {
    if (!differs && !place.address) return null
    return (
      <View style={styles.google}>
        {differs
          ? <Text style={[styles.googleText, { color: c.text }]}>On Google Maps as <Text style={styles.strong}>{place.canonicalName}</Text></Text>
          : null}
        {place.address ? <AddressLine address={place.address} /> : null}
      </View>
    )
  }

  if (status !== 'needs_check') return null

  const candidate = [place.canonicalName, place.address].filter(Boolean).join(', ')
  if (!candidate) {
    return (
      <Text style={[styles.hint, { color: c.textMuted }]}>
        Google found no match for this name. Confirming keeps it, but without a pin on the map.
      </Text>
    )
  }
  return (
    <View style={[styles.suggestion, { borderColor: c.border }]}>
      <Text style={[styles.googleText, { color: c.text }]}>
        <Text style={[styles.suggestionLabel, { color: c.textMuted }]}>Google suggests: </Text>
        {candidate}
      </Text>
      <Text style={[styles.hint, { color: c.textMuted }]}>
        A possible match, not a confirmed one. Confirm only if this is the place in the reel.
      </Text>
    </View>
  )
}

function AddressLine({ address }: { address: string }) {
  const c = useColors()
  return (
    <View style={styles.address}>
      <Ionicons name="location-outline" size={13} color={c.textMuted} style={styles.addressIcon} />
      <Text style={[styles.addressText, { color: c.textMuted }]} selectable>{address}</Text>
    </View>
  )
}

function normalise(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ')
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const c = useColors()
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: c.textMuted }]}>{title.toUpperCase()}</Text>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  )
}

// --- tips and facts ----------------------------------------------------------

const TIP_LABEL: Record<TipKind, string> = {
  do: 'Do', dont: "Don't", warning: 'Warning', hack: 'Hack', cost: 'Cost', logistics: 'Logistics',
}

export function TipList({ tips, captureId }: { tips: ApiTip[]; captureId: string }) {
  const c = useColors()
  return (
    <View style={styles.list}>
      {tips.map((tip) => {
        const warn = tip.kind === 'warning' || tip.kind === 'dont'
        return (
          <View key={tip.id} style={styles.item}>
            <View style={styles.tipHead}>
              <View style={[styles.chip, { backgroundColor: warn ? c.dangerBg : c.surfaceAlt }]}>
                <Text style={[styles.chipText, { color: warn ? c.danger : c.textMuted }]}>{TIP_LABEL[tip.kind]}</Text>
              </View>
              <Text style={[styles.itemText, { color: c.text }]} selectable>{tip.text}</Text>
            </View>
            <EvidenceFooter captureId={captureId} sourceType={tip.sourceType} seconds={tip.sourceSeconds} quote={tip.sourceQuote} />
          </View>
        )
      })}
    </View>
  )
}

/**
 * Facts are grouped by label so disagreements sit side by side — the caption
 * says ₹800, the voiceover ₹1200 — each with its own source. The app never
 * picks a winner; it only points out that the sources differ.
 */
export function FactList({ facts, captureId }: { facts: ApiFact[]; captureId: string }) {
  const c = useColors()
  const groups = new Map<string, ApiFact[]>()
  for (const fact of facts) {
    const key = normalise(fact.label)
    groups.set(key, [...(groups.get(key) ?? []), fact])
  }

  return (
    <View style={styles.list}>
      {[...groups.entries()].map(([key, group]) => {
        const first = group[0]
        if (!first) return null
        if (group.length === 1) {
          return (
            <View key={key} style={styles.item}>
              <Text style={[styles.itemText, { color: c.text }]} selectable>
                <Text style={{ color: c.textMuted }}>{first.label}: </Text>
                <Text style={styles.strong}>{first.value}</Text>
              </Text>
              <EvidenceFooter captureId={captureId} sourceType={first.sourceType} seconds={first.sourceSeconds} quote={first.sourceQuote} />
            </View>
          )
        }
        const disagree = new Set(group.map((f) => normalise(f.value))).size > 1
        return (
          <View key={key} style={styles.item}>
            <Text style={[styles.itemText, { color: c.textMuted }]}>{first.label}</Text>
            {disagree
              ? (
                <View style={styles.disagree}>
                  <Ionicons name="git-compare-outline" size={13} color={c.textMuted} />
                  <Text style={[styles.hint, { color: c.textMuted }]}>The sources disagree — each is shown with where it came from.</Text>
                </View>
              )
              : null}
            {group.map((fact) => (
              <View key={fact.id} style={styles.variant}>
                <Text style={[styles.itemText, styles.strong, { color: c.text }]} selectable>{fact.value}</Text>
                <EvidenceFooter captureId={captureId} sourceType={fact.sourceType} seconds={fact.sourceSeconds} quote={fact.sourceQuote} />
              </View>
            ))}
          </View>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  dismissed: { opacity: 0.65 },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: space.sm },
  name: { flex: 1, fontSize: font.title, fontWeight: '700', lineHeight: 22 },
  meta: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space.xs },
  metaText: { fontSize: font.small },
  from: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  fromText: { fontWeight: '600' },
  google: { gap: space.xs },
  googleText: { fontSize: font.body, lineHeight: 21 },
  strong: { fontWeight: '700' },
  suggestion: { borderWidth: 1, borderStyle: 'dashed', borderRadius: radius.md, padding: space.md, gap: space.xs },
  suggestionLabel: { fontWeight: '600' },
  hint: { fontSize: font.small, lineHeight: 17, flexShrink: 1 },
  address: { flexDirection: 'row', alignItems: 'flex-start', gap: space.xs },
  addressIcon: { marginTop: 2 },
  addressText: { flex: 1, fontSize: font.small, lineHeight: 17 },
  section: { gap: space.sm, marginTop: space.sm },
  sectionTitle: { fontSize: 11, fontWeight: '700', letterSpacing: 0.6 },
  sectionBody: { gap: space.lg },
  list: { gap: space.lg },
  item: { gap: space.sm },
  itemText: { fontSize: font.body, lineHeight: 21, flexShrink: 1 },
  tipHead: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  chip: { paddingHorizontal: space.sm, paddingVertical: 2, borderRadius: radius.pill, marginTop: 1 },
  chipText: { fontSize: font.small, fontWeight: '700' },
  disagree: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  variant: { gap: space.xs },
})
