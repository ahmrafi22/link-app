import { aiConfigured, aiEmbed, aiJson, aiVision } from "./ai";
import { cap } from "./normalize";
import { sb } from "./supabase";

/**
 * Phase ④ — one LLM call per item (quota-friendly), exactly per PLAN.md:
 *   embed → store vector → top-8 semantic neighbors (also the >0.96
 *   near-duplicate source) → RAG context (categories + neighbors + last-10
 *   feedback events) → gemini-2.5-flash JSON mode → thresholds:
 *     existing category, confidence ≥ 0.7 → assign (ai_matched)
 *     nothing fits, new proposal ≥ 0.8      → auto-create (ai_new)
 *     otherwise                             → stays uncategorized (none)
 * Manual categories are never overwritten; the AI still adds summary/topics.
 */

const MIN_MATCH = 0.7;
const MIN_NEW = 0.8;
const DUP_SIMILARITY = 0.96;
const TOPICS_MAX = 6;
const VISION_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Phase ⑥ — vision pass: look INSIDE the item's thumbnail (og:image) and
 * store what it shows (scene + visible text) as image_context. Runs BEFORE
 * aiEnrichItem so the category decision sees the picture, not just metadata.
 * Bytes pass through to Gemini and are never stored.
 */
export async function visionPassItem(id: string): Promise<{ done: boolean }> {
  try {
    if (!aiConfigured()) return { done: false };
    const item = await loadItem(id);
    if (!item?.thumbnail_url || item.image_context) return { done: false };

    const imgRes = await fetch(item.thumbnail_url, {
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });
    if (!imgRes.ok) return { done: false };
    const mimeType = (imgRes.headers.get("content-type") ?? "").split(";")[0];
    if (!mimeType.startsWith("image/")) return { done: false };
    const buf = await imgRes.arrayBuffer();
    if (buf.byteLength === 0 || buf.byteLength > VISION_MAX_BYTES) return { done: false };

    const description = await aiVision(
      Buffer.from(buf).toString("base64"),
      mimeType,
      "Describe what is visually in this image in 2-3 plain sentences. Transcribe any visible text verbatim (usernames, captions, headlines, watermarks). Output plain text only — no markdown, no preamble."
    );
    if (!description) return { done: false };

    const patch: Record<string, unknown> = { image_context: cap(description, 800) };
    const wrote = await sb(`items?id=eq.${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    // image_context needs migration 0004 — enrich anyway, skip the column
    if (!wrote.ok && patch.image_context) {
      delete patch.image_context;
      if (Object.keys(patch).length > 0) {
        await sb(`items?id=eq.${id}`, { method: "PATCH", body: JSON.stringify(patch) });
      }
    }
    return { done: true };
  } catch {
    return { done: false };
  }
}

type Item = Record<string, any>;

async function loadItem(id: string): Promise<Item | null> {
  const res = await sb(`items?id=eq.${id}&select=*&limit=1`);
  const rows = (await res.json().catch(() => null)) as Item[] | null;
  return rows?.[0] ?? null;
}

async function categoriesWithCounts(): Promise<
  Array<{ id: string; name: string; description: string | null; count: number }>
> {
  const catsRes = await sb("categories?select=id,name,description&order=name.asc");
  const cats = (await catsRes.json().catch(() => null)) as
    | Array<{ id: string; name: string; description: string | null }>
    | null;
  if (!catsRes.ok || !cats) return [];
  const countsRes = await sb("items?category_id=not.is.null&select=category_id");
  const rows = (await countsRes.json().catch(() => null)) as
    | Array<{ category_id: string }>
    | null;
  const counts = new Map<string, number>();
  for (const r of rows ?? []) counts.set(r.category_id, (counts.get(r.category_id) ?? 0) + 1);
  return cats.map((c) => ({ ...c, count: counts.get(c.id) ?? 0 }));
}

async function recentCorrections(): Promise<string[]> {
  const res = await sb(
    "feedback_events?kind=eq.recategorize&order=created_at.desc&limit=10&select=payload"
  );
  const rows = (await res.json().catch(() => null)) as
    | Array<{ payload: { category_name?: string; from_name?: string } | null }>
    | null;
  return (rows ?? [])
    .map((r) => {
      const to = r.payload?.category_name;
      const from = r.payload?.from_name;
      if (!to) return null;
      return from ? `owner moved an item from "${from}" to "${to}"` : `owner filed an item under "${to}"`;
    })
    .filter((s): s is string => Boolean(s));
}

function sanitizeTopics(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t): t is string => typeof t === "string")
    .map((t) =>
      t
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9\s-]/g, "")
        .replace(/\s+/g, "-")
        .slice(0, 24)
    )
    .filter((t) => t.length >= 2)
    .slice(0, TOPICS_MAX);
}

export type AiOutcome =
  | { status: "done"; category: string | null; duplicate: boolean }
  | { status: "failed"; reason: string }
  | { skipped: true; reason: string };

/** Run the AI pass for one item. Safe to call repeatedly; never throws. */
export async function aiEnrichItem(
  id: string,
  opts: { force?: boolean } = {}
): Promise<AiOutcome> {
  try {
    if (!aiConfigured()) return { skipped: true, reason: "ai_not_configured" };
    const item = await loadItem(id);
    if (!item) return { skipped: true, reason: "not_found" };
    if (
      !opts.force &&
      (item.category_source === "ai_matched" || item.category_source === "ai_new")
    ) {
      return { skipped: true, reason: "already_ai" };
    }

    // 1) embed → store (needed by the related_items RPC + future search)
    const embedText = [
      item.title,
      item.description,
      item.platform ? `platform: ${item.platform}` : null,
      item.raw_text,
      item.image_context,
      (item.extracted_text ?? "").slice(0, 1500),
    ]
      .filter(Boolean)
      .join("\n")
      .slice(0, 6000);
    const embedding = await aiEmbed(embedText);
    if (embedding) {
      await sb(`items?id=eq.${id}`, {
        method: "PATCH",
        body: JSON.stringify({ embedding }),
      });
    }

    // 2) semantic neighbors — same call doubles as the duplicate check
    let neighborTitles: string[] = [];
    let duplicateOf: string | null = null;
    if (embedding) {
      const rel = await sb("rpc/related_items", {
        method: "POST",
        body: JSON.stringify({ source_item: id, match_count: 8 }),
      });
      const rows = (await rel.json().catch(() => null)) as
        | Array<{
            id: string;
            title: string | null;
            platform: string | null;
            similarity: number;
          }>
        | null;
      for (const r of rows ?? []) {
        if (r.id === id) continue;
        if (
          !duplicateOf &&
          r.similarity > DUP_SIMILARITY &&
          item.platform &&
          r.platform === item.platform
        ) {
          duplicateOf = r.id;
        }
        neighborTitles.push(r.title ?? "(untitled)");
      }
    }

    // 3) RAG context
    const cats = await categoriesWithCounts();
    const context: Record<string, unknown> = {};
    context.item = {
        platform: item.platform,
        url: item.url,
        title: item.title,
        description: item.description,
        caption: item.raw_text,
        image_context: item.image_context ?? undefined,
        page_excerpt: (item.extracted_text ?? "").slice(0, 1200),
      };
    context.existing_categories = cats.map((c) => ({
      name: c.name,
      description: c.description,
      item_count: c.count,
    }));
    context.similar_items_in_vault = neighborTitles;
    context.recent_owner_corrections = await recentCorrections();

    // 4) one strict-JSON call
    const parsed = await aiJson(
      [
        "You organize one person's personal link vault.",
        "Summarize the item and decide its category.",
        "Respond with STRICT JSON only, no markdown:",
        '{"summary": "two sentences", "topics": ["kebab-case", "..."],',
        ' "category_decision": {"existing_category": "name-or-null",',
        '  "new_category": {"name": "...", "description": "one line"} or null,',
        '  "confidence": 0.0-1.0, "reason": "short"}}',
        "Rules:",
        "- Prefer an existing category; only propose new_category when nothing fits.",
        "- confidence is your certainty; 0.7+ assigns an existing category, 0.8+ creates a new one. Below those, leave both null — never guess.",
        "- topics: max 6, lowercase kebab-case.",
        "- Recent owner corrections are strong signals; follow them.",
      ].join("\n"),
      JSON.stringify(context)
    );
    if (!parsed) return { status: "failed", reason: "llm_call_failed" };

    // 5) apply thresholds
    const decision = (parsed.category_decision ?? {}) as Record<string, any>;
    const confidence = Math.min(1, Math.max(0, Number(decision.confidence) || 0));
    const patch: Record<string, unknown> = {
      summary: cap(typeof parsed.summary === "string" ? parsed.summary : null, 500),
      topics: sanitizeTopics(parsed.topics),
      status: "ready",
      category_confidence: Math.round(confidence * 100) / 100,
    };

    let assignedName: string | null = null;
    const manual = item.category_source === "manual";
    if (!manual) {
      const existingName =
        typeof decision.existing_category === "string" ? decision.existing_category.trim() : "";
      const newName =
        decision.new_category && typeof decision.new_category.name === "string"
          ? decision.new_category.name.trim()
          : "";

      if (existingName && confidence >= MIN_MATCH) {
        const hit = cats.find((c) => c.name.toLowerCase() === existingName.toLowerCase());
        if (hit) {
          patch.category_id = hit.id;
          patch.category_source = "ai_matched";
          assignedName = hit.name;
        }
      }
      if (!assignedName && !existingName && newName && confidence >= MIN_NEW && newName.length <= 40) {
        const create = await sb("categories?on_conflict=name", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=representation" },
          body: JSON.stringify({
            name: newName,
            description:
              typeof decision.new_category.description === "string"
                ? cap(decision.new_category.description, 200)
                : null,
            is_ai_created: true,
          }),
        });
        const created = (await create.json().catch(() => null)) as
          | Array<{ id: string; name: string }>
          | null;
        if (create.ok && created?.length) {
          patch.category_id = created[0].id;
          patch.category_source = "ai_new";
          assignedName = created[0].name;
        }
      }
      if (!assignedName) {
        patch.category_id = null;
        patch.category_source = "none";
      }
    }

    if (duplicateOf) patch.duplicate_of = duplicateOf;

    const wrote = await sb(`items?id=eq.${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    if (!wrote.ok) return { status: "failed", reason: "db_error" };

    return {
      status: "done",
      category: assignedName,
      duplicate: Boolean(duplicateOf),
    };
  } catch {
    return { status: "failed", reason: "unexpected" };
  }
}
