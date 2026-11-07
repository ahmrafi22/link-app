-- Link Vault — core schema (run first, in the Supabase SQL editor)
-- Matches PLAN.md "Data Model". All access happens server-side with the
-- service-role key, which bypasses RLS — so RLS is enabled on every table
-- with no policies: anon/authenticated clients get nothing.

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
  enrichment_level text not null default 'none',   -- full_device | full_server | metadata | url_only | none
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

-- Service-role-only access: the server connects with a key that bypasses
-- RLS; everyone else gets an empty result set.
alter table categories      enable row level security;
alter table items           enable row level security;
alter table fetch_cache     enable row level security;
alter table feedback_events enable row level security;
