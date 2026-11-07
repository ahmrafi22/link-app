# Link Vault

Personal, single-user capture vault. Share a link from any app → saved silently, enriched on-device, synced to your own $0/month backend.

## Layout

```
apps/mobile   Expo app (Android): silent share target, on-device extraction,
              folders + infinite-canvas UI, CI-built APK
apps/web      Next.js API + web UI (Vercel Hobby) — backend phases
supabase/     Postgres schema migrations (pgvector + hybrid search RPC),
              applied via the Supabase SQL editor
PLAN.md       master plan: architecture, free-tier limits, phase checklist
```

## CI

Every push to `main` that touches `apps/mobile/**` triggers a GitHub Actions build that publishes the APK as a Release (`build-N`). Commits scoped to `apps/web` skip the Android build.

## Secrets

Only `.env.example` files are ever committed. Real keys (`APP_SECRET`, `SUPABASE_SECRET_KEY`, `GEMINI_API_KEY`) live in the Vercel dashboard; the APK carries only `APP_SECRET`.
