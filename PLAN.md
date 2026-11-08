# Link Vault — Free-Tier Master Plan (Vercel + Supabase + Gemini)

> **New plan.** Extends and supersedes the approach in [LINK_VAULT_PLAN.md](./LINK_VAULT_PLAN.md) and [UNIVERSAL_CAPTURE_INBOX_PLAN.md](./UNIVERSAL_CAPTURE_INBOX_PLAN.md) (both left unchanged — the original Express/Redis architecture and the capture-inbox model are preserved there as reference).
> All platform limits and endpoints in this document were verified online on **2026-10-02**; sources are listed at the bottom. Facts that could not be fully verified are flagged.

## Summary
A personal, single-user capture app. From any phone app (X, Instagram, Facebook, YouTube, Reddit, the browser — anything with a share sheet), press **Share → LinkVault** and the link is saved without leaving the app. A background pipeline enriches the post with whatever is publicly retrievable (metadata, text, thumbnail), then a RAG-based AI layer summarizes it and assigns a category — creating a new category when it is confident — and the item shows up in the mobile app and the web app.

Everything runs on **$0/month**: Vercel Hobby (web + API + cron), Supabase free (Postgres + pgvector only — no object storage), Gemini API free tier (LLM + embeddings).

## What Changed Vs. The Original Plans
| Original | Now | Why |
|---|---|---|
| Express API server | Next.js route handlers (same app as the web UI) | Vercel Hobby hosts serverless functions, not long-running servers; one deployment is simpler |
| Redis queue + worker process | `after()` (post-response async) in the API route + 1 daily Vercel cron sweep | No free long-running workers on Vercel; Hobby's Fluid Compute gives **300s** max function duration — vastly more than the ~2–10s enrichment needs |
| S3 object storage | Dropped entirely — thumbnails by URL only | no binary storage anywhere |
| Docker Compose self-host phase | De-scoped to "later/optional" | Deploy target is Vercel + Supabase; schema is plain Postgres so self-host can return anytime |
| Browser extension in v1 | Bookmarklet in v1, extension later | ~10 lines, zero infrastructure |
| Categories only (Vault) / Collections + tasks (Inbox) | Flat categories + item states `inbox / saved / follow_up / archived` + duplicate detection | Absorbs the Capture Inbox model without abandoning category showcase |
| Generic metadata fetcher | Per-platform fetcher map with fallback chains | X/IG/FB/Reddit links each need their own strategy; mapped below |

## Free-Tier Stack (verified 2026-10-02)
- **Vercel Hobby** — Next.js (App Router) hosts web UI + route handlers + cron. Verified limits: Fluid Compute **on by default**, max function duration **300s**; **100 cron jobs** allowed but Hobby's **minimum interval is once per day** (sub-daily schedules fail deployment), ±1h execution precision; 100GB fast data transfer, 1M function invocations/mo, 100 deployments/day, 45-min builds. **Hobby is non-commercial/personal-use only — exactly our use case.**
- **Supabase free** — Postgres **500MB**, 5GB egress/mo, 500k edge function invocations, 2 active free projects. **pgvector + HNSW indexes fully available on the free tier.** Free projects pause after **1 week of inactivity** — our daily cron doubles as keep-alive. (No Storage — see the no-object-storage amendment.)
- **Gemini API free tier** — no billing account required; limits are per project. Google no longer publishes per-model RPM/RPD numbers — check [aistudio.google.com/rate-limit](https://aistudio.google.com/rate-limit) for live values. Community-reported late-2025: `gemini-2.5-flash` ≈ 10 RPM / **250 requests/day**. At one LLM call per item, that supports ~250 saves/day. Embeddings: **`gemini-embedding-001`** with `output_dimensionality: 768` (⚠️ `text-embedding-004` is deprecated; the newer `gemini-embedding-2` is multimodal — either works, but **never mix models**: their vector spaces are incompatible).
- **Mobile** — Expo + a **local config plugin injecting a native share target** (`ReceiverActivity` trampoline on Android; iOS later via `expo-share-extension`). `expo-share-intent` was evaluated and dropped — it opens the main app on share, which violates the no-context-switch requirement. Requires `expo prebuild` + a custom dev client — **Expo Go cannot test it**.
- **Auth** — one shared secret (`APP_SECRET`); bearer token from the mobile app, cookie for the web UI. No user accounts in v1.

## System Diagram
```mermaid
flowchart LR
  subgraph Capture["Capture Surfaces"]
    SS[Phone share sheet\nX / IG / FB / YouTube / browser]
    BM[Bookmarklet + web paste form]
  end

  subgraph Vercel["Vercel Hobby (free)"]
    API[Next.js route handlers\nbearer-token auth]
    AF[after() enrichment\n300s budget]
    CR[Daily cron sweep\nretry + Supabase keep-alive]
    W[Web UI]
  end

  subgraph SB["Supabase (free)"]
    PG[(Postgres + pgvector\nHNSW + full-text search)]
  end

  subgraph AI["Gemini API (free tier)"]
    LLM[gemini-2.5-flash\nsummary + category JSON]
    EMB[gemini-embedding-001\n768d MRL]
  end

  SS -->|POST url + caption| API
  BM --> API
  W --> API
  API -->|insert item status=pending| PG
  API --> AF
  AF -->|per-platform fetch| AF
  AF --> LLM
  AF --> EMB
  AF -->|summary, category, embedding| PG
  AF -->|thumbnail URL| PG
  CR -->|requeue pending/failed| AF
  CR --> PG
  PG --> API
  API --> W
```

## Capture Flow (the "don't leave the app" requirement)
1. In X/IG/FB/any app, tap Share → **LinkVault** (native share extension).
2. The extension grabs the URL + any caption text, POSTs `{url, text}` to `POST /api/captures` with the stored bearer token, and shows a one-line success indicator. The host app is never exited; LinkVault never opens.
3. The API normalizes the URL (strip `utm_*` + tracking params), computes `url_hash`, inserts the item `status=pending` in ~100ms.
4. `after()` (stable since Next.js **15.1.0**) runs enrichment after the response is sent — post-response work counts against the route's `maxDuration`, so export `maxDuration = 300` on the captures route. Real enrichment is ~2–10s.
5. Phone and web poll/refresh and see the item move from Inbox (pending) to categorized (ready) within ~10 seconds.
6. Offline share: the extension queues the payload locally, retries on next app open; the server cron sweeps anything stuck.

Deduplication: if `url_hash` exists, no insert — bump `seen_count`, update `last_seen_at`, return the existing item so the extension can show "already saved".

## Per-Platform Ingestion Map (endpoints live-tested 2026-10-02)
**Universal fallback chain** (each step only if the previous failed):
`platform fetcher → oEmbed → OpenGraph/Twitter meta tags → Readability text (HTML pages only) → URL + shared caption only`

Rules: one attempt per source, 6s timeout per step, **no anti-bot evasion, never scrape login-walled content** — blocked means degrade gracefully. Every item records `enrichment_level` (`full / metadata / url_only`). Responses cached 30 days in `fetch_cache`.

| Source | Share sheet gives | Primary method (free, no auth) | Verified status |
|---|---|---|---|
| X / Twitter | status URL | oEmbed — `publish.twitter.com/oembed` now 301-redirects to `publish.x.com/oembed` (follow redirects); returns author + text, no key | ✅ live-tested 2026-10-02 |
| X (enriched option) | status URL | `api.fxtwitter.com/:user/status/:id` — free open-source community JSON API incl. media | ✅ live-tested, operating |
| Instagram | post/reel URL, often caption | OG meta fetch with browser UA | caption + thumbnail sometimes; often URL + caption only (login wall) |
| Facebook | post URL | OG meta | sparse; usually URL + caption |
| Threads | post URL | OG tags | text + thumbnail usually work |
| YouTube / Shorts | watch or youtu.be URL | `youtube.com/oembed?url=...&format=json` — title, channel, thumbnail, no key | ✅ live-tested. Optional free YouTube Data API key for description/tags |
| Reddit | post URL | ⚠️ **`.json` trick is no longer reliable** — live test returned HTTP 403 "Blocked"; Reddit blocks datacenter IPs (incl. Vercel). Use **OG tags as primary** (they work for link previews), try `.json` best-effort, degrade to URL + caption. Proper fix later: free Reddit OAuth script-app | ⚠️ verified broken from Vercel IPs |
| TikTok | video URL | `tiktok.com/oembed?url=...` — documented, no auth | ✅ per official docs |
| Pinterest / LinkedIn | pin/post URL | OG tags | title/thumbnail or URL-only |
| GitHub | repo/issue URL | `api.github.com` — **60 req/hr unauthenticated per IP** | ✅ confirmed |
| Blogs / news / generic | URL | HTML fetch → OG/Twitter meta + Readability extraction | title, description, hero image, readable text |
| Pasted text / note | raw text | none | stored directly |

Honest expectations: Instagram and Facebook are login-walled — the caption captured at share time is often the strongest signal there, and the UI shows `enrichment_level` so nothing silently looks complete. Optional later upgrades behind the same fetcher interface: YouTube Data API key, Reddit OAuth app, X API, Instagram Graph API for your own account.

## Data Model (Supabase Postgres)
```sql
create extension if not exists vector;

create table categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  color text,
  is_ai_created boolean not null default false,   -- "AI created" badge, easy rename/merge
  created_at timestamptz not null default now()
);

create table items (
  id uuid primary key default gen_random_uuid(),
  url text,
  url_hash text unique,                            -- normalized URL sha256; null for pure notes
  kind text not null default 'link',               -- link | text | image
  platform text,                                   -- x | instagram | youtube | reddit | ...
  raw_text text,                                   -- share-sheet caption / pasted text
  title text,
  description text,
  thumbnail_url text,
  extracted_text text,                             -- Readability output, truncated ~15k chars
  summary text,
  topics text[] default '{}',
  embedding vector(768),                           -- gemini-embedding-001 @ output_dimensionality 768
  category_id uuid references categories(id) on delete set null,
  category_confidence numeric(3,2),
  category_source text,                            -- ai_matched | ai_new | manual | none
  status text not null default 'pending',          -- pending | ready | failed
  enrichment_level text not null default 'none',   -- full | metadata | url_only
  state text not null default 'inbox',             -- inbox | saved | follow_up | archived
  duplicate_of uuid references items(id),
  seen_count int not null default 1,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  enriched_at timestamptz,
  search_tsv tsvector generated always as (
    to_tsvector('english', coalesce(title,'') || ' ' || coalesce(description,'')
      || ' ' || coalesce(raw_text,''))
  ) stored
);

create index on items using hnsw (embedding vector_cosine_ops);
create index on items using gin (search_tsv);
create index on items (status, created_at desc);
create index on items (category_id);

create table fetch_cache (
  url_hash text primary key,
  provider text,
  payload jsonb,
  fetched_at timestamptz not null default now()
);

create table feedback_events (
  id uuid primary key default gen_random_uuid(),
  item_id uuid references items(id) on delete cascade,
  kind text not null,                              -- recategorize | rename | merge | confirm_duplicate | delete
  payload jsonb,
  created_at timestamptz not null default now()
);
```

Capacity check: a 768-dim vector ≈ 3KB → ~50MB/year of embeddings at 50 saves/day. 500MB lasts several years of heavy personal use. Never regenerate embeddings with a different model — old and new vectors are not comparable; if you ever switch, re-embed everything.

## AI & RAG Design
One LLM call per item (quota-friendly). The "AI agent" = enrichment context + retrieval from your own vault + Gemini JSON mode.

**1. Enrich** — per-platform map above.

**2. One `gemini-2.5-flash` call**, strict JSON response:
```json
{
  "summary": "2-sentence summary of the post",
  "topics": ["machine-learning", "on-device"],
  "category_decision": {
    "existing_category": "AI Papers | null",
    "new_category": { "name": "...", "description": "one line" },
    "confidence": 0.82,
    "reason": "short justification"
  }
}
```

**3. RAG context assembled before that call:**
- Current category list (name, description, item counts).
- Top-8 existing items by cosine similarity (title + summary + category as few-shot evidence).
- Last ~10 correction events (`feedback_events`) so recent reclassifications steer future suggestions.

**4. Decision rules (AI is advisory, thresholds visible in UI):**
- Existing category, confidence ≥ 0.7 → assign (`ai_matched`).
- No fit, new category proposal with confidence ≥ 0.8 → auto-create (`ai_new`, badged) and assign.
- Otherwise → stays in Inbox uncategorized rather than guess.

**5. Embedding** — `gemini-embedding-001` at 768 dims (recommended MRL tier; model input cap is 2,048 tokens, so embed `title + summary + platform + first ~1,500 chars` of extracted text/caption). Cached per `url_hash`. HNSW cosine index.

**6. Duplicates** — exact via `url_hash` at insert; near-duplicates via cosine similarity > 0.96 on the same platform → `duplicate_of`, confirmed in one tap (a `feedback_event`).

**7. Feedback loop** — every manual move/rename/merge writes a `feedback_event`; corrections are retrieved into future prompts. Recategorize is one tap.

**8. Search (hybrid)** — Postgres FTS rank + pgvector cosine rank combined via RRF in one SQL function (`match_items(query, query_embedding, filters)`); "related items" on the detail page via pure vector similarity. All DB access uses the `service_role` secret key server-side only (standard Supabase trusted-server pattern; note Supabase is migrating key naming to `sb_publishable_` / `sb_secret_`).

## Background Processing Without A Queue
```ts
// apps/web/app/api/captures/route.ts (shape)
export const maxDuration = 300; // Hobby max with Fluid Compute

export async function POST(req: Request) {
  const item = await insertCapture(await req.json());      // fast insert, status=pending
  after(async () => { await enrich(item.id); });           // after-response, counts against maxDuration
  return Response.json({ id: item.id, status: "pending" });
}
```
- `enrich()` is idempotent and step-isolated: if metadata lands but the LLM call fails, the item is still marked `ready` with `category_source=none` (waits in Inbox).
- One daily cron (`/api/cron/sweep`, protected by `CRON_SECRET`) in `vercel.json` (Hobby minimum interval is once per day — sub-daily fails deployment): (a) re-runs `enrich()` for stale `pending`/`failed` items in a small batch, (b) runs a **heartbeat upsert** on Supabase so the free project never pauses (what exactly counts as "activity" isn't officially documented — a write is the safe bet).
- If volume ever outgrows this, bolt on **Upstash QStash free (1,000 messages/day)** or **Inngest free (50,000 executions/month — note steps count individually)**; no schema changes needed.

## API (all route handlers under `apps/web`, guarded by `APP_SECRET`)
- `POST /api/captures` — share extension, web paste form, bookmarklet. `{url?, text?}`
- `GET /api/captures?state=&category=&q=&cursor=` — cursor-paginated feed
- `GET|PATCH|DELETE /api/captures/:id` — detail, edit (recategorize/rename/archive), delete
- `POST /api/captures/:id/recategorize` — correction + feedback event
- `GET|POST /api/categories`, `PATCH|DELETE /api/categories/:id`, `POST /api/categories/:id/merge`
- `GET /api/search?q=` — hybrid FTS + vector
- `GET /api/captures/:id/related` — vector neighbors
- `POST /api/cron/sweep` — cron only (`CRON_SECRET`)
- `GET /api/health` — keep-alive target

## Repository Structure
```
linkvault/
  apps/
    web/          # Next.js: UI + route handlers + cron route (deployed to Vercel)
    mobile/       # Expo app + share extension (prebuild / EAS or local build)
  packages/
    shared/       # zod schemas, API client, types used by web + mobile
  supabase/
    migrations/   # schema + pgvector + match_items() RPC
```

Environment variables: `APP_SECRET`, `CRON_SECRET`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (service-role; `sb_secret_…` naming on newer projects), `GEMINI_API_KEY`, optional `YOUTUBE_API_KEY`.

## Mobile App
- Expo + expo-router; screens: **Inbox** (recent, pending indicators), **Categories** grid (cover thumbnails, AI-created badge), **Category detail**, **Item detail** (thumbnail, summary, topics, `enrichment_level` chip, actions: open original / recategorize / follow-up / delete), **Search**, **Settings** (paste personal token once → `expo-secure-store`).
- Share intake via a native share target wired by a local config plugin (`plugins/with-android-share-target.js`): invisible `ReceiverActivity` (`ACTION_SEND`, `text/*`) queues the payload into an inbox file and finishes — the app **never opens** and the sender app keeps focus. Requires prebuild + custom dev client — not Expo Go. Build Android first (fast iteration), iOS second (`expo-share-extension`).
- The extension POSTs directly to the API; the app never needs to open. Failed POSTs queue locally, retry on next open.

## Web App
Same data, better for triage: masonry feed, category management (rename, merge, delete, AI-created visibility), item detail with extracted-text reader and related items, hybrid search, bulk select → recategorize/archive/delete, and the manual paste/capture form. Bookmarklet: `javascript:location.href='https://<app>.vercel.app/save?url='+encodeURIComponent(location.href)`.

## Free-Tier Budget (verified 2026-10-02)
| Service | Free allowance | Used for | Verdict |
|---|---|---|---|
| Vercel Hobby | 300s functions (Fluid Compute), 100GB transfer, 1M invocations/mo, cron once-per-day, **non-commercial use only** | web + API + cron | fits (personal use is exactly the Hobby terms) |
| Supabase free | 500MB DB, 5GB egress, 2 active projects, pauses after 1 week inactive | DB only — no storage | fits; daily cron = keep-alive |
| Gemini API free | no billing required; live limits in AI Studio dashboard (community-reported: flash ≈ 10 RPM / 250 RPD) | 1 LLM call + 1 embedding per item, cached | fits personal volume |
| EAS Build free | ~30 low-priority cloud builds/mo (max 15 iOS); `eas build --local` free & unlimited | RN binaries with share extension | fits — iterate with local builds |
| **Total** | | | **$0/month** |

## Phases
1. **Foundation** — monorepo, Supabase migrations (schema + pgvector + match RPC), Next.js app with token auth + `POST /api/captures`, deployed to Vercel with daily cron sweep + Supabase heartbeat.
2. **Mobile share intake** — Expo shell, native trampoline share target + inbox drain, POSTing to the API, Inbox screen listing raw captures, offline queue. *(Highest-risk phase — validate the share target with a dev build before any AI work.)*
3. **Enrichment pipeline** — per-platform fetcher map, fallback chain, `fetch_cache`, thumbnail caching, `after()` wiring with `maxDuration = 300`, `enrichment_level` surfacing.
4. **AI layer** — embeddings (gemini-embedding-001 @ 768), single-call summary + categorization with thresholds and auto-create rules, duplicates, feedback events, recategorize flow.
5. **Search & showcase** — hybrid search RPC, related items, category management on web (merge/rename/bulk), item detail polish on both clients.
6. **Optional / later** — browser extension (supersedes bookmarklet), Reddit OAuth app + official YouTube/IG/X keys, tasks/follow-up reminders, self-host Docker Compose, QStash/Inngest if volume grows, multi-user (would require leaving Hobby terms → Pro or self-host).

## Risks & Mitigations
- **IG/FB content walls** — planned: caption-at-share-time is the primary signal; `enrichment_level` is honest in the UI; official APIs are the later path. No scraping of login-walled/anti-bot content.
- **Reddit 403s from Vercel IPs** (verified) — OG tags primary for Reddit; `.json` best-effort only; OAuth script-app later if needed.
- **Gemini quota exhaustion** — items stay `pending`, daily cron retries; one-call-per-item + caching stays far under caps; Groq free tier (e.g., `openai/gpt-oss-120b`, 30 RPM / 1,000 RPD — check console.groq.com for live values) as a second LLM key. Verify Gemini's live numbers in AI Studio before launch since Google no longer publishes them.
- **Embedding model lock-in** — pick `gemini-embedding-001` @ 768 and never mix; a switch means a full re-embed.
- **Supabase pausing** — daily cron heartbeat write (activity definition is unofficial; a write is safest).
- **Share target is the riskiest mobile piece** — it is ~80 lines of our own Kotlin behind a config plugin: validate with a dev build in Phase 2; the JS side degrades gracefully (undrained inbox lines stay on disk until the next drain).
- **AI mislabels** — advisory-only thresholds, Inbox fallback instead of forced guesses, one-tap corrections that persist as retrieval context.

## Test Plan
- Share a tweet, an IG reel, a FB post, a YouTube video, and a blog post from the phone → each becomes one item with the correct `enrichment_level`; the login-walled ones degrade without crashing.
- Share the same URL twice → dedupe: `seen_count` bumps, no second item.
- Kill network mid-share → queued locally, saves on next open.
- AI suggests a category; force a correction → `feedback_event` recorded and reflected in later suggestions.
- Search a phrase that only exists in extracted text → FTS finds it; search a concept paraphrase → vector finds it.
- Idle 8 days → cron heartbeat prevented the Supabase pause; force-fail 3 items → cron sweep repairs them.

## Definition Of Done
From X, Instagram, or Facebook on my phone, I press Share → LinkVault without leaving the app. Within ~10 seconds the post is in my Inbox with the best-available preview, a summary, and either the right category or a clear "needs review" state. New categories appear on their own when the AI is confident and are easy to rename. Everything is searchable (keywords and meaning) on both the phone and the web, duplicates are caught, corrections make the AI smarter — and the whole thing costs $0/month.

---

## Verified Facts & Sources (fetched 2026-10-02)
- Vercel function limits & Fluid Compute default: vercel.com/docs/functions/limitations · Fair-use allowances: vercel.com/docs/limits/fair-use-guidelines · General limits (cron, deployments, non-commercial Hobby): vercel.com/docs/limits + vercel.com/docs/cron-jobs/usage-and-pricing
- Next.js `after()` stable ≥15.1, counts against maxDuration: nextjs.org/docs/app/api-reference/functions/after
- Supabase plan limits (500MB DB / 5GB egress / pause after 1 week): supabase.com/pricing
- pgvector + HNSW on Supabase: supabase.com/docs/guides/database/extensions/pgvector · supabase.com/docs/guides/ai/vector-indexes/hnsw-indexes
- Gemini rate limits (free tier, no billing; per-model numbers now live-only in dashboard): ai.google.dev/gemini-api/docs/rate-limits · Embeddings (gemini-embedding-001/2, MRL 128–3072 dims, text-embedding-004 deprecated): ai.google.dev/gemini-api/docs/embeddings
- expo-share-intent (achorein — evaluated, rejected because it opens the main app on share): github.com/achorein/expo-share-intent · react-native-share-menu unmaintained: npmjs.com/package/react-native-share-menu
- oEmbed live tests: publish.x.com/oembed (X, via redirect from publish.twitter.com) · youtube.com/oembed · tiktok oembed per developers.tiktok.com/doc/embed-videos · fxtwitter per github.com/FixTweet/FixTweet/wiki/Status-Fetch-API
- Reddit `.json` 403 from datacenter IPs: live test + community reports · GitHub 60 req/hr unauthenticated: docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
- EAS free plan + local builds: docs.expo.dev/billing/plans · QStash free (1,000 msg/day): upstash.com/pricing/qstash · Inngest free (50k executions/mo): inngest.com/pricing · Groq free tier: console.groq.com/docs/rate-limits

**Flagged as unverified / live-check before building:** exact Gemini per-model RPM/RPD (check aistudio.google.com/rate-limit), exact current EAS free build count (confirm on billing page), Supabase's precise "activity" definition for pausing.

---

## Final Build Decisions (2026-11-07)

Decisions locked during Phase 2 (mobile). Supersede the conflicting notes above.

**Mobile**
- Expo SDK 57, **share UX = silent trampoline, NOT app-opens** (user requirement: never leave the sender app). `expo-share-intent` was dropped — it redirects to the main app by design. Replaced by a local config plugin (`plugins/with-android-share-target.js`) that injects `ReceiverActivity` at prebuild: `Theme.NoDisplay`, `noHistory`, empty `taskAffinity`, `ACTION_SEND`/`text/*` filter. It appends the payload to `files/linkvault/inbox.jsonl`, shows a toast, finishes in ms; the app drains that file via `expo-file-system` (`src/lib/inbox.ts`) on open/foreground and reuses the normal dedupe/merge path.
- iOS later = `expo-share-extension` (in-place share sheet). `image/*` + Gemini vision only when screenshot capture is scheduled.
- **On-device extraction shipped (v0.2.0, pre-backend)** — `src/lib/extract.ts` implements the device-assisted half of the hybrid model: YouTube/TikTok oEmbed, Reddit `.json`, GitHub API, generic OG/Twitter-card fallback; 7-day cache (1-day negative), 7 s/step timeout, 5-attempt budget, 3-way concurrency, runs on app open/foreground. Surfaces as `enrichment_level` chips in the item detail screen. Reddit may still 403 depending on network/fingerprint — the fallback chain handles it. The server waterfall (Phase ③) later merges the same fields via `client_extracted`.
- Android-only until the web phase.
- Local-first sync: AsyncStorage (`linkvault.items.v1`) is a **cache, not the store**. Launch → `GET /api/captures` replaces cache; capture → optimistic local insert + `POST /api/captures`; failures queue in an outbox, retried next launch. Token pasted once in Settings → `expo-secure-store`.
- `SplashScreen.preventAutoHideAsync()` must never be called without a matching `hideAsync()` (expo-router hides the splash itself) — this was the stuck-splash bug.

**CI/CD (github.com/ahmrafi22/link-app, public)**
- Push to `main` → GitHub Actions: `npm ci` → `expo prebuild -p android --no-install` (`android/` is never committed) → patch `networkTimeout=120000` into `gradle-wrapper.properties` (10 s default timed out on runners) → `./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a,armeabi-v7a`, signed with the template `debug.keystore` → artifact + auto-Release `build-N`. Concurrency cancels superseded runs. Debug-signed is fine for sideload; real keystore only at Play-store time.
- Standalone APKs bundle JS at build: **every** change needs a new build (no Metro). JS iteration happens with `npm start` + dev client.

**Backend**
- `apps/web` Next.js App Router on Vercel Hobby = UI + API in one deploy. No Express, no worker; enrichment in `after()` (`maxDuration = 300`); daily cron requeues + Supabase heartbeat.
- Auth: single `APP_SECRET` bearer (mobile) / cookie (web). All DB access server-side with the service-role key — **the APK carries only `APP_SECRET`**; Gemini/Supabase keys are extractable from any APK and never ship in one.
- Supabase schema as specified above (items / categories / fetch_cache / feedback_events, pgvector HNSW, hybrid search RPC).

**Extraction — hybrid, device-assisted**
- The phone does the IP-sensitive fetches that fail from datacenter IPs: Reddit `.json`, OG/meta tags, YouTube `timedtext`, Jina Reader. It sends results as `client_extracted {source, title, description, image, text}` on the capture POST. Server size-caps, prefers it over re-fetching, falls back to its own chain, records provenance in `enrichment_level` (`full_device | full_server | metadata | url_only`).
- Server waterfall: platform fetcher → oEmbed → OG/meta → Readability/Jina → shared caption. 6 s timeout per step, one attempt each, 30-day `fetch_cache`. Error taxonomy: `RATE_LIMITED | PLATFORM_BLOCKED | NOT_FOUND | UPSTREAM_BROKEN`.
- Login-walled (IG/FB): the share-time caption **is** the content. No wall-scraping, no video downloads (yt-dlp out of scope). Reference implementation of the pattern: Panniantong/agent-reach (local-browser sessions — the local-only part does not transfer to serverless).

**AI layer**
- One `gemini-2.5-flash` call per item, JSON mode (summary / topics / category_decision). RAG context: category list + top-8 cosine neighbors + last-10 `feedback_events`. Thresholds: ≥ 0.7 existing match, ≥ 0.8 auto-create, else stays Inbox. Embeddings `gemini-embedding-001` @ 768 — never mix models (switch = full re-embed). Duplicates: `url_hash` exact + cosine > 0.96 same-platform.

**Build order**: ① API skeleton (POST/GET captures + health) deployed + smoke-tested → ② mobile sync/outbox/Settings → ③ server waterfall + fetch_cache → ④ Gemini + embeddings → ⑤ hybrid search + web triage UI. Screenshot capture (image/* + Gemini vision) slots in after ④.

**Amendment — no object storage (2026-11-07, applied throughout the document)**
- Supabase Storage is **dropped**. The only server-side storage is the Postgres database; the stack is now exactly Vercel + Supabase Postgres/pgvector + Gemini.
- Schema change: `items.thumbnail_path` is removed; items keep `thumbnail_url` only. The thumbnail-copy step disappears from `after()` enrichment — the pipeline is now metadata → AI → embedding, no binary handling anywhere.
- Clients load thumbnails straight from source CDNs with their own image cache; an expired/broken image falls back to the colored platform tile the grid already renders. Trade-off accepted: CDNs that expire URLs (Instagram/Facebook in particular) lose thumbnails over time — title/summary/text are the durable data.
- Escape hatch without a new service: if durable thumbnails ever matter, store a size-capped compressed blob in a `bytea` column — still "only a database."
- Future screenshots: image bytes stay on-device; only the extracted/OCR'd text syncs to the DB.
- Side effects: Supabase egress drops sharply (no image traffic through Supabase), and the 50 MB/file + 1 GB Storage free-tier lines above become irrelevant.

**Phase ① kickoff checklist (2026-11-07 — ✅ COMPLETE, same day)**

Deployment: **https://web-two-lake-29.vercel.app** (Vercel Hobby, Root Directory `apps/web`). Supabase project `rqbitdqgefjoyhcuagcw` with both migrations applied; env vars `APP_SECRET` + `SUPABASE_URL` + `SUPABASE_SECRET_KEY` set in Vercel. Smoke test passed 2026-11-07: health `supabase:"ok"`, capture 201 with platform detect + tracking-param strip + `capturedAt` honored, dedupe bumped `seen_count`, list OK; test row deleted afterwards.

Baseline when this was written: mobile at v0.4.1 on `main` (build-15 green), share capture + on-device extraction + folders/canvas UI shipped. User confirmed extraction works on-device.

1. ✅ **Repo restructure → monorepo** — DONE (branch `chore/monorepo-restructure`, merged; build-16 green on the moved workflow):
   - Repo root lifted: mobile app now at `apps/mobile`, all files 100% renames (history follows), remote `ahmrafi22/link-app` unchanged.
   - `.github/workflows/build-apk.yml` moved to repo root with `working-directory: apps/mobile` + `paths:` filter — verified: web-only merges to main skip the APK build.
   - `PLAN.md` now under version control at the repo root.
2. ✅ **`apps/web` skeleton** — DONE (branch `feat/web-api-skeleton`, merged): Next.js 16 App Router; `GET /api/health` (config report + Supabase ping); `POST /api/captures` (bearer auth timing-safe, tracking-param URL normalize, `url_hash` dedupe → bumps `seen_count`, accepts `clientExtracted` → `full_device`/`metadata`, 503 until Supabase env set); `GET /api/captures?state=&limit=`; `.env.example` placeholders only. Locally smoke-tested: 401/400/503 ladder verified.
3. ✅ **Supabase migrations** — DONE (branch `feat/supabase-migrations`, merged): `supabase/migrations/0001_core_schema.sql` (4 tables, pgvector 768d + HNSW, FTS generated column, RLS enabled, no policies) and `0002_search_rpc.sql` (`match_items` RRF hybrid + `related_items`). User pastes both into the Supabase SQL editor in order.
4. ⬜ **User pre-work (the user's turn now)**: create Supabase project (→ `SUPABASE_URL` + service-role key), Vercel Hobby account, Gemini key (only needed at Phase ④). Vercel: import repo, **Root Directory = `apps/web`**, env vars: `APP_SECRET` (value handed to user at kickoff — keep it out of the repo), `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (service role). All secrets live only in Vercel env vars — never in the repo, never in the APK.
5. ⬜ **Smoke test**: `curl` health + a capture POST against the deployed URL; then Phase ② (mobile sync/outbox/Settings screen). ✅ (done 2026-11-07 — see header note above)

---

## Phase ② — Mobile sync / outbox / Settings (2026-11-07, ✅ shipped as v0.5.0, build-17)

Branch `feat/mobile-sync-settings`, 5 commits, merged to `main`. Mobile typecheck clean; web build clean.

- **`src/lib/api.ts`** — API client. Config = deployment URL + `APP_SECRET`, pasted once in Settings, stored via `expo-secure-store` (keychain, never AsyncStorage/repo). Endpoints: `testConnection` (health), `postCapture`, `getCaptures`, `deleteCapture`. Invariant carried over from extract.ts: **no `signal` on fetch** — `Promise.race` timeout, fetch rejections swallowed so the race loser can't raise unhandled rejections.
- **`src/lib/sync.ts`** — local-first sync. Uploads = items with no `serverId` POST to the API (server dedupes on `url_hash`, so retries are safe). Pulls = GET 200 newest, merged: server wins for content it has, local keeps id/favorite/local-only extraction when equal-or-better (`LEVEL_RANK` compare incl. `full_device/full_server → full`). Deletes: `noteItemDeleted` records a pending delete synchronously, replayed as `DELETE /api/captures/:id`, then tombstoned (`linkvault.tombstones.v1`) so pulls never resurrect. Favorites stay device-local by design.
- **`src/app/settings.tsx`** — API base URL + APP_SECRET inputs, "Save + test" (reports db state + warns if server has no APP_SECRET), "Sync now" (runs a round via AsyncStorage directly), "Disconnect". Version marker in header.
- **Home** — ⚙ gear opens Settings; after drain on open/foreground the app runs **sync → then enrichment**; subtitle shows `· N to sync` only when a server is configured; `useFocusEffect` reloads from storage + config so Settings actions are reflected on back-navigation.
- **Server** — added `DELETE /api/captures/:id` (bearer auth, uuid-validated). Auto-deploy to Vercel confirmed live (401 guard).
- Store: `VaultItem` gains `serverId`/`syncedAt` (backfilled); `useVault` gains `applyAll`/`reload`; `saveItems` exported for Settings.

**Phase ③ next**: server enrichment waterfall in `after()` + `fetch_cache` (Reddit needs OG-primary from datacenter IPs), cron sweep + Supabase heartbeat, `CRON_SECRET` env var. ✅ **DONE (2026-11-08, v0.5.x branch `feat/server-enrichment`)**

## Phase ③ — Server enrichment pipeline (2026-11-08, ✅ shipped, live-verified)

Branch `feat/server-enrichment`, 5 commits, merged to `main`, Vercel auto-deployed, verified on production (fresh YouTube link → `full_server` + thumbnail + `ready` in ~14 s).

- **`lib/enrich.ts`** — waterfall per plan: platform fetchers (YouTube oEmbed, GitHub API, fxtwitter→x oEmbed for X, TikTok oEmbed, Reddit `.json` best-effort behind OG) → OG/Twitter meta with browser UA → retry with the sanctioned link-preview UA (`facebookexternalhit`). 6 s/step, one attempt per source, richest result wins — platform fetchers get a +2 score bonus over generic OG (fxtwitter's tweet text + likes beat X's thin og tags). Readability-lite paragraph extraction capped 15 k for Phase ④ embeddings.
- **`fetch_cache`** — successes 30 days, negative `UPSTREAM_BROKEN` entries 1 day (cron retries daily without hammering).
- **`after()` on POST /api/captures** — the capture returns in ~100 ms; enrichment fills gaps afterwards. Device-extracted data is never downgraded (`rank()` compare: full_device/full_server > metadata > url_only). `meta` PATCH falls back gracefully until migration 0003 is applied.
- **`/api/cron/sweep`** (GET|POST, `vercel.json` 05:00 UTC daily) — re-enriches stale pending/failed (never-tried or >24 h since last try), batch 10; heartbeat upsert on `fetch_cache` keeps Supabase from pausing. **Fail-closed**: 401 unless `Authorization: Bearer $CRON_SECRET` (Vercel sends it automatically once the env var exists). Note: nested PostgREST `and=(or=(…),or=(…))` logic trees failed to parse — sweep uses two plain queries merged client-side.
- **Migration `0003_item_meta.sql`** — `items.meta jsonb` (user pastes into SQL editor; until then platform metadata (stars/likes/channel) is computed but not persisted).
- Live-verified locally + on prod: YouTube (title/thumb/channel), GitHub API (note: facebook/react renamed → canonical `react/react`, followed correctly), X via fxtwitter ("just setting up my twttr"), blog.google (og + 15 k chars text), Instagram via preview-UA (worked from server), cron auth 401/401/200 + sweep + heartbeat.

**Phase ④ next**: Gemini embeddings + one-call summary/categorization, duplicates, feedback events — needs `GEMINI_API_KEY` in Vercel.

---

## Future improvements (parked, not scheduled)

- **Daily cron sweep + Supabase heartbeat (parked 2026-11-08, user decision)** — the sweep endpoint (`/api/cron/sweep`) is built, tested and stays in the codebase, but the schedule (`vercel.json`) was removed. Consequences, all acceptable for now:
  - failed items are **not** auto-retried daily — the server still enriches once at capture time (`after()`), and any item can be re-swept manually: `curl -H "Authorization: Bearer $CRON_SECRET" https://web-two-lake-29.vercel.app/api/cron/sweep`
  - Supabase **pauses after ~1 week of no activity** — regular app use counts as activity, so this only bites if the vault is abandoned for 7+ days (restore free from the Supabase dashboard).
  - To re-activate: restore `vercel.json` `{"crons":[{"path":"/api/cron/sweep","schedule":"0 5 * * *"}]}` + set `CRON_SECRET` in Vercel + redeploy.



