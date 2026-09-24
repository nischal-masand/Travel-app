import { useCallback, useState } from 'react'
import { Linking, RefreshControl, ScrollView, StyleSheet, View } from 'react-native'
import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router'
import { Button, Card, HelperText, Icon, List, ProgressBar, Text } from 'react-native-paper'
import type { ApiCapture, ApiPlace, ApiPlaceDetail, ApiPlaceStatus } from '@reel/shared'
import { api } from '../../src/api'
import { ErrorBanner, Loading, Notice } from '../../src/components/ui'
import { FactList, PlaceCard, ResultNotes, ReviewActions, TipList, stopClip, toError } from '../../src/evidence'
import { captureByline, relativeTime } from '../../src/format'
import { useApi } from '../../src/useApi'
import { space, useAppTheme } from '../../src/theme'

/**
 * One reel, and everything that came out of it — with the evidence for each
 * place and an honest account of what couldn't be read.
 */
export default function CaptureScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { colors } = useAppTheme()
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
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void refresh()}
            tintColor={colors.primary}
            colors={[colors.primary]}
            progressBackgroundColor={colors.surfaceContainerHigh}
          />
        }
      >
        <Header capture={capture} />
        <Progress capture={capture} />

        {confirmed.length > 0 || toCheck.length > 0 || dismissed.length > 0
          ? (
            <View style={styles.section}>
              <Text variant="titleLarge">Places</Text>
              <Text variant="bodyMedium" style={{ color: colors.onSurfaceVariant }}>
                {placeSummary(confirmed.length, toCheck.length)}
              </Text>
            </View>
          )
          : null}

        {confirmed.map(renderPlace)}

        {toCheck.length > 0
          ? (
            <>
              {confirmed.length > 0
                ? <Text variant="titleSmall" style={{ color: colors.primary }}>Needs your check</Text>
                : null}
              {toCheck.map(renderPlace)}
            </>
          )
          : null}

        {dismissed.length > 0
          ? (
            <List.Accordion
              title={`${dismissed.length} dismissed`}
              left={(props) => <List.Icon {...props} icon="close-circle-outline" />}
              expanded={showDismissed}
              onPress={() => setShowDismissed((v) => !v)}
              style={styles.accordion}
            >
              <View style={styles.dismissedList}>{dismissed.map(renderPlace)}</View>
            </List.Accordion>
          )
          : null}

        {capture.status === 'done' && data.places.length === 0
          ? (
            <Card mode="outlined">
              <Card.Title
                title="No places found in this reel"
                titleVariant="titleMedium"
                left={(props) => <Icon {...props} source="map-marker-off-outline" />}
              />
              <Card.Content>
                <Text variant="bodyMedium" style={{ color: colors.onSurfaceVariant }}>
                  {hasGeneral
                    ? 'Nothing it said, showed or captioned named a specific place. It did have tips and facts — below.'
                    : 'Nothing it said, showed or captioned named a specific place.'}
                </Text>
              </Card.Content>
            </Card>
          )
          : null}

        {capture.status === 'done' || capture.status === 'failed'
          ? <ResultNotes capture={capture} rejected={data.rejected} />
          : null}

        {hasGeneral
          ? (
            <Card>
              <Card.Title
                title="For the whole trip"
                titleVariant="titleMedium"
                subtitle="Tips and facts not tied to one place"
                subtitleVariant="bodySmall"
              />
              <Card.Content style={styles.general}>
                {data.generalTips.length > 0 ? <TipList tips={data.generalTips} captureId={capture.id} /> : null}
                {data.generalFacts.length > 0 ? <FactList facts={data.generalFacts} captureId={capture.id} /> : null}
              </Card.Content>
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
  const { colors } = useAppTheme()
  const [expanded, setExpanded] = useState(false)
  const [openFailed, setOpenFailed] = useState(false)
  const caption = capture.caption?.trim() ?? ''
  const long = caption.length > 160 || caption.split('\n').length > 3
  const byline = captureByline(capture)
  const saved = relativeTime(capture.createdAt)
  const platform = PLATFORM_NAME[capture.platform]

  return (
    <Card>
      <Card.Title
        title={byline || 'Shared link'}
        titleVariant="titleLarge"
        subtitle={saved ? `Saved ${saved}` : undefined}
        subtitleVariant="bodySmall"
        subtitleStyle={{ color: colors.onSurfaceVariant }}
      />
      <Card.Content style={styles.headerBody}>
        {capture.destination
          ? (
            <View style={styles.destination}>
              <Icon source="map-marker-outline" size={18} color={colors.primary} />
              <Text variant="titleSmall">{capture.destination}</Text>
            </View>
          )
          : null}

        {caption
          ? (
            <View>
              <Text variant="bodyMedium" numberOfLines={expanded || !long ? undefined : 3} selectable>
                {caption}
              </Text>
              {long
                ? (
                  <Button mode="text" compact onPress={() => setExpanded((v) => !v)} style={styles.more}>
                    {expanded ? 'Show less' : 'Show full caption'}
                  </Button>
                )
                : null}
            </View>
          )
          : null}
        {openFailed
          ? <HelperText type="error" padding="none">Couldn't open {capture.url}</HelperText>
          : null}
      </Card.Content>
      <Card.Actions>
        <Button
          mode="outlined"
          icon="open-in-new"
          onPress={() => {
            setOpenFailed(false)
            Linking.openURL(capture.url).catch(() => setOpenFailed(true))
          }}
        >
          {platform ? `Open on ${platform}` : 'Open original'}
        </Button>
      </Card.Actions>
    </Card>
  )
}

/**
 * While the server works: its own progress line, live. On failure: its own
 * error, verbatim — "quota exhausted" means wait, "post is private" means
 * this reel can't be read at all, and a generic message would hide which.
 */
function Progress({ capture }: { capture: ApiCapture }) {
  const { colors } = useAppTheme()

  if (capture.status === 'queued' || capture.status === 'running') {
    return (
      <Card mode="contained">
        <Card.Title
          title={capture.status === 'queued' ? 'Waiting in line' : 'Reading the reel'}
          titleVariant="titleMedium"
          subtitle={capture.step ?? undefined}
          subtitleNumberOfLines={2}
          subtitleStyle={[styles.tabular, { color: colors.onSurfaceVariant }]}
        />
        <Card.Content style={styles.progressBody}>
          <ProgressBar indeterminate />
          <Text variant="bodySmall" style={{ color: colors.onSurfaceVariant }}>
            This usually takes under a minute. The page updates by itself — you can leave and come back.
          </Text>
        </Card.Content>
      </Card>
    )
  }

  if (capture.status === 'failed') {
    return (
      <Notice
        title="Couldn't process this reel"
        body={capture.error ?? 'The server gave no reason.'}
        inset={false}
      />
    )
  }

  return null
}

const styles = StyleSheet.create({
  content: { padding: space.lg, gap: space.lg, paddingBottom: space.xxl },
  section: { gap: 2, marginTop: space.sm },
  accordion: { paddingHorizontal: 0 },
  dismissedList: { gap: space.lg },
  general: { gap: space.lg },
  headerBody: { gap: space.md },
  destination: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  more: { alignSelf: 'flex-start', marginLeft: -space.sm },
  progressBody: { gap: space.md },
  tabular: { fontVariant: ['tabular-nums'] },
})
