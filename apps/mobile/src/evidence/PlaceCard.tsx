import type { ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import { Button, Card, Chip, Icon, Surface, Text } from 'react-native-paper'
import type { ApiFact, ApiMention, ApiPlace, ApiPlaceStatus, ApiTip, PlaceKind, TipKind } from '@reel/shared'
import { StatusChip } from '../components/ui'
import { shape, space, useAppTheme } from '../theme'
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
  const { colors } = useAppTheme()
  const kind = KIND_LABEL[place.kind]
  const tips = place.tips ?? []
  const facts = place.facts ?? []

  return (
    <Card style={status === 'dismissed' ? styles.dismissed : undefined}>
      <Card.Content style={styles.content}>
        <View style={styles.titleRow}>
          <Text variant="titleLarge" style={styles.name} selectable>{place.name}</Text>
          <StatusChip status={status} confidence={place.confidence} />
        </View>

        {kind || from
          ? (
            <View style={styles.meta}>
              {kind ? <Text variant="bodyMedium" style={{ color: colors.onSurfaceVariant }}>{kind}</Text> : null}
              {from
                ? (
                  <Button
                    mode="text"
                    compact
                    icon="chevron-right"
                    contentStyle={styles.trailingIcon}
                    onPress={from.onPress}
                    accessibilityRole="link"
                  >
                    {from.label}
                  </Button>
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
      </Card.Content>

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
  const { colors } = useAppTheme()
  const differs = !!place.canonicalName && normalise(place.canonicalName) !== normalise(place.name)

  if (status === 'confirmed') {
    if (!differs && !place.address) return null
    return (
      <View style={styles.google}>
        {differs
          ? (
            <Text variant="bodyMedium">
              On Google Maps as <Text variant="titleSmall">{place.canonicalName}</Text>
            </Text>
          )
          : null}
        {place.address ? <AddressLine address={place.address} /> : null}
      </View>
    )
  }

  if (status !== 'needs_check') return null

  const candidate = [place.canonicalName, place.address].filter(Boolean).join(', ')
  if (!candidate) {
    return (
      <Text variant="bodySmall" style={{ color: colors.onSurfaceVariant }}>
        Google found no match for this name. Confirming keeps it, but without a pin on the map.
      </Text>
    )
  }
  return (
    <Surface elevation={0} style={[styles.suggestion, { backgroundColor: colors.surfaceVariant }]}>
      <View style={styles.suggestionHead}>
        <Icon source="map-search-outline" size={18} color={colors.onSurfaceVariant} />
        <Text variant="labelLarge" style={{ color: colors.onSurfaceVariant }}>Google suggests</Text>
      </View>
      <Text variant="bodyMedium" style={{ color: colors.onSurfaceVariant }} selectable>{candidate}</Text>
      <Text variant="bodySmall" style={{ color: colors.onSurfaceVariant }}>
        A possible match, not a confirmed one. Confirm only if this is the place in the reel.
      </Text>
    </Surface>
  )
}

function AddressLine({ address }: { address: string }) {
  const { colors } = useAppTheme()
  return (
    <View style={styles.address}>
      <Icon source="map-marker-outline" size={16} color={colors.onSurfaceVariant} />
      <Text variant="bodySmall" style={[styles.flex, { color: colors.onSurfaceVariant }]} selectable>{address}</Text>
    </View>
  )
}

function normalise(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ')
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const { colors } = useAppTheme()
  return (
    <View style={styles.section}>
      <Text variant="labelLarge" style={{ color: colors.primary }}>{title}</Text>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  )
}

// --- tips and facts ----------------------------------------------------------

const TIP_LABEL: Record<TipKind, string> = {
  do: 'Do', dont: "Don't", warning: 'Warning', hack: 'Hack', cost: 'Cost', logistics: 'Logistics',
}

export function TipList({ tips, captureId }: { tips: ApiTip[]; captureId: string }) {
  const { colors } = useAppTheme()
  return (
    <View style={styles.list}>
      {tips.map((tip) => {
        const warn = tip.kind === 'warning' || tip.kind === 'dont'
        return (
          <View key={tip.id} style={styles.item}>
            <View style={styles.tipHead}>
              <Chip
                compact
                accessibilityRole="text"
                selectedColor={warn ? colors.onErrorContainer : colors.onSecondaryContainer}
                style={{ backgroundColor: warn ? colors.errorContainer : colors.secondaryContainer }}
              >
                {TIP_LABEL[tip.kind]}
              </Chip>
              <Text variant="bodyMedium" style={styles.flex} selectable>{tip.text}</Text>
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
  const { colors } = useAppTheme()
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
              <Text variant="bodyMedium" selectable>
                <Text variant="bodyMedium" style={{ color: colors.onSurfaceVariant }}>{first.label}: </Text>
                <Text variant="titleSmall">{first.value}</Text>
              </Text>
              <EvidenceFooter captureId={captureId} sourceType={first.sourceType} seconds={first.sourceSeconds} quote={first.sourceQuote} />
            </View>
          )
        }
        const disagree = new Set(group.map((f) => normalise(f.value))).size > 1
        return (
          <View key={key} style={styles.item}>
            <Text variant="bodyMedium" style={{ color: colors.onSurfaceVariant }}>{first.label}</Text>
            {disagree
              ? (
                <View style={styles.disagree}>
                  <Icon source="compare-horizontal" size={16} color={colors.onSurfaceVariant} />
                  <Text variant="bodySmall" style={[styles.flex, { color: colors.onSurfaceVariant }]}>
                    The sources disagree — each is shown with where it came from.
                  </Text>
                </View>
              )
              : null}
            {group.map((fact) => (
              <View key={fact.id} style={styles.variant}>
                <Text variant="titleSmall" selectable>{fact.value}</Text>
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
  content: { gap: space.md },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: space.sm },
  name: { flex: 1 },
  meta: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space.sm },
  trailingIcon: { flexDirection: 'row-reverse' },
  google: { gap: space.xs },
  flex: { flex: 1 },
  suggestion: { borderRadius: shape.medium, padding: space.md, gap: space.xs },
  suggestionHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  address: { flexDirection: 'row', alignItems: 'flex-start', gap: space.xs },
  section: { gap: space.sm, marginTop: space.xs },
  sectionBody: { gap: space.lg },
  list: { gap: space.lg },
  item: { gap: space.sm },
  tipHead: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  disagree: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  variant: { gap: space.xs },
})
