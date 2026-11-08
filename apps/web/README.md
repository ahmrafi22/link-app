# Link Vault — API

Next.js (App Router) on Vercel Hobby: capture API now, triage web UI in a later phase.

## Endpoints

| Route | Auth | What |
|---|---|---|
| `GET /api/health` | none | liveness + config report; pings Supabase when configured |
| `POST /api/captures` | Bearer `APP_SECRET` | capture intake: `{url?, text?, title?, capturedAt?, clientExtracted?}`; dedupes on `url_hash` (existing → bumps `seen_count`, returns `{saved:"existing"}`); new → inserts `status=pending`, returns 201 with the row |
| `GET /api/captures?state=&limit=` | Bearer `APP_SECRET` | newest-first feed (`state` ∈ inbox/saved/follow_up/archived, limit 1–200, default 50) |
| `DELETE /api/captures/:id` | Bearer `APP_SECRET` | remove one item (phone delete sync) |
| `POST /api/captures/:id/retry` | Bearer `APP_SECRET` | forced re-enrichment + AI pass for one item (phone retry button) |
| `POST /api/captures/:id/recategorize` | Bearer `APP_SECRET` | manual correction `{category_id: uuid\|null}` — sets `category_source=manual` (AI never overrides), records a feedback event |
| `GET\|POST /api/categories` | Bearer `APP_SECRET` | list with item counts / create manually |
| `GET\|POST /api/cron/sweep` | Bearer `CRON_SECRET` | **manual only** — re-enrich stale pending/failed items (batch 10) + Supabase heartbeat. Not scheduled; daily cron is a future improvement |

AI layer (Phase ④): after enrichment, one `gemini-2.5-flash` JSON-mode call per item → summary + topics + category (existing ≥0.7 assigned, new ≥0.8 auto-created, else uncategorized) + `gemini-embedding-001` @ 768 dims (near-duplicates >0.96 same platform). Any OpenAI-compatible endpoint works instead via `OPENAI_API_KEY`/`OPENAI_BASE_URL`/`OPENAI_MODEL`/`OPENAI_EMBEDDING_MODEL` — Gemini wins when both are set. Without a key everything degrades gracefully: items just stay uncategorized.

`clientExtracted` carries the phone's on-device extraction result (`{title, description, image, source}`) so the server skips re-fetching — sets `enrichment_level` to `full_device`/`metadata`. The server fills gaps in `after()` (Phase ③ waterfall: platform fetchers → OG, 6 s/step, successes cached 30 days in `fetch_cache`, errors 1 day) and the daily cron sweeps anything left stale.

All auth failures: 401. Missing Supabase env: 503.

## Local dev

```bash
npm install
cp .env.example .env.local   # fill in real values
npm run dev
```

## Deploy (Vercel)

1. Import the repo; set **Root Directory = `apps/web`** (framework auto-detects Next.js).
2. Environment variables (Project → Settings → Environment Variables): `APP_SECRET`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY` — and later `GEMINI_API_KEY`, `CRON_SECRET`.
3. Deploy, then smoke test:

```bash
curl https://<app>.vercel.app/api/health
curl -X POST https://<app>.vercel.app/api/captures \
  -H "Authorization: Bearer <APP_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://x.com/jack/status/20","text":"smoke test"}'
```

## Secrets

- The APK carries **only** `APP_SECRET`.
- `SUPABASE_SECRET_KEY` (service role) bypasses all row-level security — Vercel env vars only, never in the app, never committed.
