-- Link Vault — Phase ③: per-platform enrichment metadata
-- (run in the Supabase SQL editor after 0001 + 0002)
-- Stores platform-specific bits from the server waterfall: stars, language,
-- channel, likes, subreddit… The phone has had a local `meta` since v0.2;
-- this column lets the server waterfall persist its own and lets both sync.

alter table items add column if not exists meta jsonb;
