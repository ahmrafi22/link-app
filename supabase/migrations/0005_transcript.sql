-- Phase ⑦: spoken-content transcripts (TikTok WebVTT / Facebook SRT / IG audio-ASR).
-- transcript holds the plain-text spoken content, capped ~15k chars server-side.
-- search_tsv is a generated column, so the new expression needs a drop+re-add
-- (generated columns cannot be altered in place); the GIN index is rebuilt with it.

alter table items add column if not exists transcript text;

alter table items drop column if exists search_tsv;
alter table items add column search_tsv tsvector generated always as (
  to_tsvector('english', coalesce(title,'') || ' ' || coalesce(description,'')
    || ' ' || coalesce(raw_text,'') || ' ' || coalesce(transcript,''))
) stored;

create index if not exists items_search_tsv_idx on items using gin (search_tsv);
