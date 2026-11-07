# Supabase

The database for Link Vault: Postgres + pgvector. Free tier (500 MB) is enough for years of personal use. No object storage — thumbnails stay as URLs.

## Applying the schema

No CLI needed — paste each file, **in order**, into the Supabase dashboard → **SQL Editor** → New query → Run:

1. `migrations/0001_core_schema.sql` — `vector` extension, `items` / `categories` / `fetch_cache` / `feedback_events`, HNSW + full-text indexes, RLS enabled
2. `migrations/0002_search_rpc.sql` — `match_items()` hybrid search (FTS + vector, RRF) and `related_items()` vector neighbors

Verify afterwards:

```sql
select table_name from information_schema.tables
where table_schema = 'public';
-- expect: categories, fetch_cache, feedback_events, items

select proname from pg_proc where proname in ('match_items','related_items');
```

## Keys

Project Settings → API gives you the URL and the service-role secret:

- `SUPABASE_URL` — e.g. `https://abcd1234.supabase.co`
- `SUPABASE_SECRET_KEY` (newer projects, `sb_secret_…`) or the classic `SUPABASE_SERVICE_ROLE_KEY` — the API accepts either name

The service-role key **bypasses all row-level security**. It lives only in the Vercel environment variables. It never goes into the mobile app, never gets committed, and only the Next.js server uses it.

RLS is enabled on every table with no policies: the service role is unaffected, and anon/authenticated clients (e.g. anyone hitting Supabase's auto REST API) see nothing.
