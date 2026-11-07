-- Link Vault — hybrid search RPC (run second)
-- Combines Postgres full-text rank and pgvector cosine rank with Reciprocal
-- Rank Fusion (k=60), per PLAN.md "AI & RAG Design" §8. Called server-side
-- with the service-role key (RLS-enabled tables, no policies).

create or replace function match_items(
  query_text text,
  query_embedding vector(768),
  match_count int default 10,
  filter_state text default null    -- inbox | saved | follow_up | archived | null = any
)
returns table (
  id uuid,
  url text,
  title text,
  summary text,
  platform text,
  category_id uuid,
  state text,
  created_at timestamptz,
  score double precision
)
language sql stable
as $$
  with semantic as (
    select id, row_number() over (order by embedding <=> query_embedding) as rank
    from items
    where embedding is not null
      and (filter_state is null or state = filter_state)
    order by embedding <=> query_embedding
    limit 24
  ),
  lexical as (
    select id, rank from (
      select id, row_number() over (order by ts_rank_cd(search_tsv, q) desc) as rank
      from items, websearch_to_tsquery('english', query_text) q
      where search_tsv @@ q
        and (filter_state is null or state = filter_state)
      order by ts_rank_cd(search_tsv, q) desc
      limit 24
    ) ranked
  ),
  rrf as (
    select id, 1.0 / (60 + rank) as s from semantic
    union all
    select id, 1.0 / (60 + rank) as s from lexical
  )
  select i.id, i.url, i.title, i.summary, i.platform,
         i.category_id, i.state, i.created_at,
         sum(r.s)::double precision as score
  from rrf r
  join items i on i.id = r.id
  group by i.id, i.url, i.title, i.summary, i.platform,
           i.category_id, i.state, i.created_at
  order by score desc
  limit match_count
$$;

-- Pure-vector neighbors for the "related items" row on the detail page.
create or replace function related_items(
  source_item uuid,
  match_count int default 6
)
returns table (
  id uuid,
  title text,
  url text,
  platform text,
  category_id uuid,
  similarity double precision
)
language sql stable
as $$
  select i.id, i.title, i.url, i.platform, i.category_id,
         1 - (i.embedding <=> s.embedding) as similarity
  from items s, items i
  where s.id = source_item
    and i.id <> source_item
    and i.embedding is not null
    and s.embedding is not null
  order by i.embedding <=> s.embedding
  limit match_count
$$;
