# Reel → Trip

Share an Instagram reel (or YouTube / Shorts / TikTok) and get back structured,
mappable data: the places, the do's and don'ts, the costs, the best time to go.

**Full design and build order: [`.claude/plans/hey-i-want-to-mossy-wreath.md`](C:/Users/Nischal-AMD/.claude/plans/hey-i-want-to-mossy-wreath.md)**

## The one rule

The AI is never allowed to *name* a place. Perception (Stage A) produces only
verbatim text — what was said, what was on screen, what the caption said.
Interpretation (Stage B) reads only that text and must quote its source for
every item. A **code check**, not a prompt instruction, drops anything whose
quote isn't in the evidence. Geocoding (Stage C) is the second gate: a place
that doesn't exist can't be resolved.

## Status

- [x] **Phase 0** — monorepo scaffold
- [x] **Phase 1** — Stage A: the evidence bundle (resolve, frames, OCR, 2-pass ASR)
- [x] **Phase 2** — Stages B + C: interpretation, quote guard, reconciliation, geocoding
- [x] **Phase 3a** — HTTP API, SQLite storage, job queue, evidence endpoints
- [ ] **Phase 3b** — the Expo app ← *resume here*
- [ ] Phase 4 — map + collections · Phase 5 — web · Phase 6 — recipe profile · Phase 7 — deploy

## Where to pick up

The backend is complete and proven end to end on real Instagram reels. What's
left is the app.

```bash
npm run api -w @reel/server          # start the server on :3000
npm test -w @reel/server             # 4 suites, offline, no keys
npm run capture -- "<url>"           # same pipeline, straight to the terminal
```

**Next: Phase 3b, the Expo app.**

1. `apps/mobile` — Expo + Expo Router + TypeScript.
2. `expo-share-intent` for the share sheet. It uses native code, so it needs a
   **custom dev build** (EAS), not Expo Go — plan for one build cycle before
   anything is testable on the phone.
3. Screens: Inbox (poll `GET /captures`) → Capture card (`GET /captures/:id`) →
   **Needs-check tray** (`GET /needs-check`), which shows `/frame?at=` and
   `/clip?at=` so a name can be judged without reopening Instagram.
4. Point the app at the server over your LAN IP or ngrok — `localhost` on the
   phone is the phone.

**Known rough edges, deliberately left:**

- Countries and cities ("Japan", "Tokyo") become pins. They geocode fine, but a
  country is not an itinerary stop — they probably belong as destination context.
- Extraction is not deterministic even at temperature 0: two runs of one reel
  gave 9 and 7 places. Fine for a tray you review; don't trust counts.
- `ocr:compare` has never been run — Cloudflare/Moondream is unproven as a
  fallback. The keys are in `.env`, so it is one command away.

## Setup

Requires Node 22+, ffmpeg and yt-dlp on PATH (all present on this machine).

```bash
npm install
cp .env.example .env    # then fill in the three keys below
```

All three have free tiers that cover personal use with nothing to pay:

| Key | Where | Free tier |
|---|---|---|
| `GROQ_API_KEY` | [console.groq.com/keys](https://console.groq.com/keys) | 2,000 transcriptions/day, no card |
| `GEMINI_API_KEY` | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | free tier, no billing account |
| `APIFY_TOKEN` | [console.apify.com](https://console.apify.com/settings/integrations) | $5/mo credits, no card |

`APIFY_TOKEN` is only needed for Instagram. YouTube, Shorts and TikTok go
through yt-dlp and need no key at all.

## Use

```bash
# Fetch only — no model calls, no credits spent. Use this to debug a resolver.
npm run capture -- "<url>" --resolve-only

# Full Stage A: resolve, frames, OCR, two-pass transcription.
npm run capture -- "<url>"

# Raw bundle instead of the readable report.
npm run capture -- "<url>" --json

# Offline tests: ffmpeg paths and vocabulary biasing. No keys, no network.
npm run smoke -w @reel/server

# Caption + audio only, no OCR. Use when the Gemini daily quota is gone.
OCR_ENGINE=none npm run capture -- "<url>"
```

### When Gemini says "quota exhausted"

The free-tier daily cap is **per model**. Measured against the live API: with
`gemini-3.5-flash` exhausted, `gemini-3.5-flash-lite` and three others still
answered normally. So the pipeline never retries an exhausted model (that only
spends the remainder faster) but does move straight down its model chain.

The quota resets at midnight US Pacific. If every model in the chain is out,
`OCR_ENGINE=none` runs on caption + audio — but expect to lose place names that
appear *only* as text on screen.

Each capture writes everything to `.work/<captureId>/` — video, frames, audio,
and `evidence.json`.

## Phase 1 is a gate

Don't build Phase 2 until the transcripts are good, because everything
downstream inherits their errors.

Run five reels you actually saved, spanning: voiceover with no caption, text
overlays with no speech, a carousel of stills, one non-English, and one with no
real information. Then read the output and check:

1. **Are the place names spelled right?** Overall accuracy will look fine while
   every proper noun is wrong — that's the failure mode that matters.
2. **Did pass 2 improve them?** The report prints a word-level diff of pass 1 → 2
   so you can see exactly what the vocabulary biasing changed.
3. **Do timestamps land within a second?**

## How transcription works

Travel reels are the worst case for speech recognition: foreign place names,
music underneath, accented voiceovers. So it transcribes twice.

1. **Pass 1** — cold, with word-level timings and confidence.
2. **Build a vocabulary** from the sources that spell correctly: caption,
   hashtags, Instagram's location tag, and text read off the frames.
3. **Pass 2** — re-transcribe biased toward that vocabulary, but only when pass 1
   shows low confidence on capitalised tokens.

The caption is the spelling authority. Google Places will never resolve
"noosa peneeda", so the caption fixing it to "Nusa Penida" is what makes the map
pin appear at all.

## Layout

```
packages/shared/src/evidence.ts     Stage A schemas — verbatim only
packages/shared/src/extraction.ts   Stage B/C schemas — quote-carrying
packages/server/src/resolvers/      instagram (Apify) · ytdlp (YT/TikTok)
packages/server/src/perception/     media · ocr · asr · vocabulary · bundle
packages/server/src/cli.ts          Phase 1 entry point
```

## Notes

- **Docker isn't installed.** Phase 1 needs no database. At Phase 2, either
  install Docker Desktop and run `docker compose up -d`, or skip it entirely
  and point `DATABASE_URL` at a free hosted Postgres (neon.tech).
- **yt-dlp breaks often.** YouTube 403s stale versions; run `yt-dlp -U` when
  fetching starts failing.
- **Apify actors drift.** When one breaks, change `APIFY_INSTAGRAM_ACTOR` in
  `.env`; if the output shape differs, `pickItem` in `resolvers/instagram.ts`
  is the only place that should need editing.


## What five real reels taught us

Findings from running actual saved Instagram posts, each now guarded by a test:

- **Real video is limited-range YUV**, which ffmpeg's mjpeg encoder refuses.
  Synthetic full-range test clips hid this completely.
- **Instagram delivers DASH**, so a reel's `videoUrl` is often video-ONLY and the
  speech sits in a separate `audioUrl`. Missing it reads as "this reel is silent".
- **Carousel slides carry `displayUrl`, not `images`** — and `images` is present
  but empty, so `images ?? displayUrl` silently yields nothing.
- **Posts using a licensed music track are skipped, deliberately.** There is no
  speech to transcribe, and putting song lyrics into the evidence would let
  Stage B quote a lyric as the source for a place nobody mentioned.
- **Whisper's per-word confidence is useless here.** Measured across whole
  transcripts it sits at 0.90-0.91, so it cannot tell a rare proper noun from
  the word "This". The pass-2 trigger is instead "a name the caption spells out
  is missing from the transcript".
- **Biasing can make things worse.** On one reel it turned a correct
  "Matching Planet" into "Mac-shun Planet", because the vocabulary was mostly
  topic hashtags and sentence-opening capitals. Two guards now: junk is filtered
  out of the bias list, and pass 2 is only kept when it demonstrably recovers a
  name — otherwise pass 1 wins and the report says so.
- **Gemini's free-tier daily quota is per MODEL.** Retrying an exhausted model
  only spends the remainder faster, but the next model in the chain usually
  answers fine. Verified live: 3.5-flash exhausted while four others served.
- **On-screen text earns its place in the pipeline.** One capture's only source
  of "Beach Swing Yurari" was a frame — no caption mention, and no audio at all
  (licensed music). Drop OCR and that place disappears entirely.


## HTTP API

```
POST /captures {url}          share a link -> 202 {id, status}
GET  /captures                inbox, newest first
GET  /captures/:id            status, places, mentions, tips, rejections
GET  /needs-check             the tray: everything unverified
GET  /map                     confirmed pins, deduped across captures
GET  /captures/:id/frame?at=  the still at that second
GET  /captures/:id/clip?at=   3 seconds of audio around it (404 if silent)
```

Processing is asynchronous: a share returns immediately and the app polls.
The queue is in-process and serial — the work is bounded by free-tier rate
limits, not CPU, so running captures in parallel would only make three providers
throttle at once.

## What running it on real reels taught us

Every item below was found by running the pipeline, not by reasoning about it,
and each is now pinned by a test.

- **Google always answers something.** For an invented cafe it returns a real,
  nearby, differently-named business. Accepting the top hit would launder a
  hallucination into a verified pin, so every candidate is graded against the
  queried name.
- **Grading beats yes/no.** "Ultraman" was confirmed as "ULTRAMAN STREET" while
  "Golden Gai" was rejected despite Google answering "Shinjuku Golden-Gai".
  Clustering and geocoding now treat the same grade differently, because the
  priors differ: two names from the same reel are probably one shop, a geocoder
  offering a longer name is offering a guess.
- **A hashtag is not prose.** "#goldengai" outranked the voiceover's "Golden
  Gai" on source rank and handed Google an unresolvable string.
- **Whisper's per-word confidence is useless here** — 0.90-0.91 across a whole
  transcript. The pass-2 trigger is "a caption-spelled name is missing".
- **Biasing can make transcripts worse** — it turned "Matching Planet" into
  "Mac-shun Planet". Pass 2 is now kept only when it demonstrably recovers a name.
- **Licensed music tracks are not transcribed.** Song lyrics in the evidence
  would let Stage B cite a lyric as the source for a place nobody mentioned.
- **Instagram serves DASH**, so a reel's video often has no audio track at all
  and the speech is in a separate stream.
- **Gemini's free quota is per model**, not per project — an exhausted model is
  skipped, never retried.
