# Link Vault — API

Next.js (App Router) on Vercel Hobby: capture API now, triage web UI in a later phase.

## Endpoints

| Route | Auth | What |
|---|---|---|
| `GET /api/health` | none | liveness + config report; pings Supabase when configured |
| `POST /api/captures` | Bearer `APP_SECRET` | capture intake: `{url?, text?, title?, capturedAt?, clientExtracted?}`; dedupes on `url_hash` (existing → bumps `seen_count`, returns `{saved:"existing"}`); new → inserts `status=pending`, returns 201 with the row |
| `GET /api/captures?state=&limit=` | Bearer `APP_SECRET` | newest-first feed (`state` ∈ inbox/saved/follow_up/archived, limit 1–200, default 50) |

`clientExtracted` carries the phone's on-device extraction result (`{title, description, image, source}`) so the server skips re-fetching — sets `enrichment_level` to `full_device`/`metadata`. Enrichment via `after()` lands in Phase ③ (`maxDuration` is already reserved).

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
