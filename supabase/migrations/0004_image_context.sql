-- Link Vault — Phase ⑥: what is visually inside an item's thumbnail
-- (run in the Supabase SQL editor after 0001–0003)
-- Written by the vision pass (Gemini) and consumed by categorization,
-- search embeddings, and the detail screen.

alter table items add column if not exists image_context text;
