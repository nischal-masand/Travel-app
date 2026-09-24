import { useCallback, useState } from 'react'
import { ActivityIndicator, Linking, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import type { ApiCapture, ApiPlace, ApiPlaceDetail, ApiPlaceStatus } from '@reel/shared'
import { api } from '../../src/api'
import { Button, Card, ErrorBanner, Loading } from '../../src/components/ui'
import { FactList, PlaceCard, ResultNotes, ReviewActions, TipList, stopClip, toError } from '../../src/evidence'
import { captureByline, relativeTime } from '../../src/format'
import { useApi } from '../../src/useApi'
import { font, radius, space, useColors } from '../../src/theme'

/**
 * One reel, and everything that came out of it — with the evidence for each
 * place and an honest account of what couldn't be read.
 */
export default function CaptureScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const c = useColors()
  const { data, error, loading, refreshing, refresh, reload, setData } = useApi(
    () => api.getCapture(id),
    { pollWhile: (d) => d.capture.status === 'queued' || d.capture.status === 'running' },
  )
  // A verdict shows at once; the server's answer (or a refresh) replaces it.
  const [overrides, setOverrides] = useState<Readonly<Record<string, ApiPlaceStatus>>>({})
  const [failures, setFailures] = useState<Readonly<Record<string, Error>>>({})
  const [showDismissed, setShowDismissed] = useState(false)

  useFocusEffect(useCallback(() => () => stopClip(), []))

  const setOverride = (placeId: string, status: ApiPlaceStatus | null) => setOverrides((prev) => {
    const next = { ...prev }
    if (status) next[placeId] = status
    else delete next[placeId]
    return next
  })

  const setFailure = (placeId: string, err: Error | null) => setFailures((prev) => {
    const next = { ...prev }
    if (err) next[placeId] = err
    else delete next[placeId]
    return next
  })

  const patchPlace = (placeId: string, updated: ApiPlace) => setData((prev) => prev && {
    ...prev,
    places: prev.places.map((p) => (p.id === placeId ? { ...p, ...updated } : p)),
  })

  async function verdict(place: ApiPlaceDetail, kind: 'confirm' | 'dismiss') {
    setFailure(place.id, null)
    setOverride(place.id, kind === 'confirm' ? 'confirmed' : 'dismissed')
    try {
      const updated = kind === 'confirm' ? await api.confirmPlace(place.id) : await api.dismissPlace(place.id)
      patchPlace(place.id, updated)
      await reload()
    } catch (err) {
      setFailure(place.id, toError(err))
    } finally {
      setOverride(place.id, null)
    }
  }

  async function correct(place: ApiPlaceDetail, name: string): Promise<ApiPlace> {
    setFailure(place.id, null)
    const updated = await api.correctPlace(place.id, name)
    patchPlace(place.id, updated)
    void reload()
    return updated
  }

  if (loading) return <Loading />
  if (!data) {
    return error ? <ErrorBanner error={error} onRetry={() => void refresh()} /> : <Loading />
  }

  const { capture } = data
  const statusOf = (p: ApiPlaceDetail) => overrides[p.id] ?? p.status
  const confirmed = data.places.filter((p) => statusOf(p) === 'confirmed')
  const toCheck = data.places.filter((p) => statusOf(p) === 'needs_check')
  const dismissed = data.places.filter((p) => statusOf(p) === 'dismissed')
  const hasGeneral = data.generalTips.length > 0 || data.generalFacts.length > 0

  const renderPlace = (p: ApiPlaceDetail) => {
    const status = statusOf(p)
    return (
      <PlaceCard key={p.id} place={p} status={status}>
        {status === 'needs_check'
          ? (
            <ReviewActions
              place={p}
              error={failures[p.id] ?? null}
              onConfirm={() => void verdict(p, 'confirm')}
              onDismiss={() => void verdict(p, 'dismiss')}
              onCorrect={(name) => correct(p, name)}
            />
          )
          : null}
      </PlaceCard>
    )
  }

  return (
    <>
      <Stack.Screen options={{ title: capture.author ? `@${capture.author}` : 'Capture' }} />
      {error ? <ErrorBanner error={error} onRetry={() => void refresh()} /> : null}
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={c.accent} colors={[c.accent]} />
        }
      >
        <Header capture={capture} />
        <Progress capture={capture} />

        {confirmed.length > 0 || toCheck.length > 0 || dismissed.length > 0
          ? (
            <View style={styles.section}>
              <Text style={[styles.sectionTitle, { color: c.text }]}>Places</Text>
              <Text style={[styles.sectionSub, { color: c.textMuted }]}>{placeSummary(confirmed.length, toCheck.length)}</Text>
            </View>
          )
          : null}

        {confirmed.map(renderPlace)}

        {toCheck.length > 0
          ? (
            <>
              {confirmed.length > 0
                ? <Text style={[styles.groupTitle, { color: c.textMuted }]}>NEEDS YOUR CHECK</Text>
                : null}
              {toCheck.map(renderPlace)}
            </>
          )
          : null}

        {dismissed.length > 0
          ? (
            <>
              <Pressable
                onPress={() => setShowDismissed((v) => !v)}
                accessibilityRole="button"
                accessibilityState={{ expanded: showDismissed }}
                hitSlop={8}
                style={({ pressed }) => [styles.toggle, { opacity: pressed ? 0.6 : 1 }]}
              >
                <Text style={[styles.toggleText, { color: c.textMuted }]}>
                  {dismissed.length} dismissed
                </Text>
                <Ionicons name={showDismissed ? 'chevron-up' : 'chevron-down'} size={16} color={c.textMuted} />
              </Pressable>
              {showDismissed ? dismissed.map(renderPlace) : null}
            </>
          )
          : null}

        {capture.status === 'done' && data.places.length === 0
          ? (
            <Card>
              <Text style={[styles.cardTitle, { color: c.text }]}>No places found in this reel</Text>
              <Text style={[styles.meta, { color: c.textMuted }]}>
                {hasGeneral
                  ? 'Nothing it said, showed or captioned named a specific place. It did have tips and facts — below.'
                  : 'Nothing it said, showed or captioned named a specific place.'}
              </Text>
            </Card>
          )
          : null}

        {capture.status === 'done' || capture.status === 'failed'
          ? <ResultNotes capture={capture} rejected={data.rejected} />
          : null}

        {hasGeneral
          ? (
            <Card>
              <Text style={[styles.cardTitle, { color: c.text }]}>For the whole trip</Text>
              <Text style={[styles.sectionSub, { color: c.textMuted }]}>Tips and facts not tied to one place.</Text>
              {data.generalTips.length > 0 ? <TipList tips={data.generalTips} captureId={capture.id} /> : null}
              {data.generalFacts.length > 0 ? <FactList facts={data.generalFacts} captureId={capture.id} /> : null}
            </Card>
          )
          : null}
      </ScrollView>
    </>
  )
}

function placeSummary(confirmed: number, toCheck: number): string {
  const parts = [
    confirmed ? `${confirmed} confirmed` : null,
    toCheck ? `${toCheck} to check` : null,
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'None kept'
}

const PLATFORM_NAME: Record<string, string> = { instagram: 'Instagram', youtube: 'YouTube', tiktok: 'TikTok' }

/** Who posted it, where it's about, what they wrote, and a way back to it. */
function Header({ capture }: { capture: ApiCapture }) {
  const c = useColors()
  const [expanded, setExpanded] = useState(false)
  const [openFailed, setOpenFailed] = useState(false)
  const caption = capture.caption?.trim() ?? ''
  const long = caption.length > 160 || caption.split('\n').length > 3
  const byline = captureByline(capture)
  const saved = relativeTime(capture.createdAt)
  const platform = PLATFORM_NAME[capture.platform]

  return (
    <Card>
      <Text style={[styles.byline, { color: c.text }]}>{byline || 'Shared link'}</Text>
      {saved ? <Text style={[styles.meta, { color: c.textMuted }]}>Saved {saved}</Text> : null}

      {capture.destination
        ? (
          <View style={styles.destination}>
            <Ionicons name="location-outline" size={15} color={c.textMuted} />
            <Text style={[styles.destinationText, { color: c.text }]}>{capture.destination}</Text>
          </View>
        )
        : null}

      {caption
        ? (
          <View style={styles.caption}>
            <Text style={[styles.captionText, { color: c.text }]} numberOfLines={expanded || !long ? undefined : 3} selectable>
              {caption}
            </Text>
            {long
              ? (
                <Pressable onPress={() => setExpanded((v) => !v)} accessibilityRole="button" hitSlop={8}>
                  <Text style={[styles.more, { color: c.accent }]}>{expanded ? 'Show less' : 'Show full caption'}</Text>
                </Pressable>
              )
              : null}
          </View>
        )
        : null}

      <Button
        label={platform ? `Open original on ${platform}` : 'Open original reel'}
        variant="secondary"
        onPress={() => {
          setOpenFailed(false)
          Linking.openURL(capture.url).catch(() => setOpenFailed(true))
        }}
      />
      {openFailed
        ? <Text style={[styles.meta, { color: c.danger }]} selectable>Couldn't open {capture.url}</Text>
        : null}
    </Card>
  )
}

/**
 * While the server works: its own progress line, live. On failure: its own
 * error, verbatim — "quota exhausted" means wait, "post is private" means
 * this reel can't be read at all, and a generic message would hide which.
 */
function Progress({ capture }: { capture: ApiCapture }) {
  const c = useColors()

  if (capture.status === 'queued' || capture.status === 'running') {
    return (
      <Card>
        <View style={styles.progressRow}>
          <ActivityIndicator color={c.accent} />
          <View style={styles.progressText}>
            <Text style={[styles.cardTitle, { color: c.text }]}>
              {capture.status === 'queued' ? 'Waiting in line' : 'Reading the reel'}
            </Text>
            {capture.step
              ? <Text style={[styles.step, { color: c.textMuted }]} selectable>{capture.step}</Text>
              : null}
          </View>
        </View>
        <Text style={[styles.meta, { color: c.textMuted }]}>
          This usually takes under a minute. The page updates by itself — you can leave and come back.
        </Text>
      </Card>
    )
  }

  if (capture.status === 'failed') {
    return (
      <View style={[styles.failed, { backgroundColor: c.dangerBg }]} accessibilityRole="alert">
        <Text style={[styles.cardTitle, { color: c.danger }]}>Couldn't process this reel</Text>
        <Text style={[styles.failedText, { color: c.danger }]} selectable>
          {capture.error ?? 'The server gave no reason.'}
        </Text>
      </View>
    )
  }

  return null
}

const styles = StyleSheet.create({
  content: { padding: space.lg, gap: space.lg, paddingBottom: space.xxl },
  section: { gap: 2, marginTop: space.sm },
  sectionTitle: { fontSize: font.heading, fontWeight: '700' },
  sectionSub: { fontSize: font.small },
  groupTitle: { fontSize: 11, fontWeight: '700', letterSpacing: 0.6, marginTop: space.sm },
  cardTitle: { fontSize: font.title, fontWeight: '700' },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: space.xs, alignSelf: 'flex-start', paddingVertical: space.xs },
  toggleText: { fontSize: font.body, fontWeight: '600' },
  byline: { fontSize: font.title, fontWeight: '700' },
  meta: { fontSize: font.small, lineHeight: 17 },
  destination: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  destinationText: { fontSize: font.body, fontWeight: '600' },
  caption: { gap: space.xs },
  captionText: { fontSize: font.body, lineHeight: 21 },
  more: { fontSize: font.small, fontWeight: '700' },
  progressRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  progressText: { flex: 1, gap: 2 },
  step: { fontSize: font.small, fontVariant: ['tabular-nums'] },
  failed: { padding: space.lg, borderRadius: radius.lg, gap: space.sm },
  failedText: { fontSize: font.body, lineHeight: 21 },
})
