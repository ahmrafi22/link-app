import { after } from "next/server";

import { aiEnrichItem, visionPassItem } from "@/lib/aiEnrich";
import { checkAuth, unauthorized } from "@/lib/auth";
import { enrichItem } from "@/lib/enrich";
import { supabaseConfigured } from "@/lib/env";
import { cap, detectPlatform, normalizeUrl, urlHash } from "@/lib/normalize";
import { sb, sbErrorMessage } from "@/lib/supabase";

export const dynamic = "force-dynamic";
// enrichment via after() lands in Phase ③; the insert itself is fast and
// never needs 300s, but reserving the budget now avoids a surprise later
export const maxDuration = 300;

const STATES = new Set(["inbox", "saved", "follow_up", "archived"]);

interface ClientExtracted {
  title?: unknown;
  description?: unknown;
  image?: unknown;
  source?: unknown;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * POST /api/captures — capture intake (share target, web paste, bookmarklet).
 * Body: { url?, text?, title?, capturedAt?, clientExtracted?: {...} }
 * Dedupes on url_hash: an existing URL bumps seen_count instead of inserting.
 */
export async function POST(req: Request) {
  if (!checkAuth(req)) return unauthorized();

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const rawUrl = str(body.url);
  const text = str(body.text);
  if (!rawUrl && !text) {
    return Response.json({ error: "url_or_text_required" }, { status: 400 });
  }
  if (!supabaseConfigured()) {
    return Response.json(
      { error: "supabase_not_configured", hint: "set SUPABASE_URL + SUPABASE_SECRET_KEY" },
      { status: 503 }
    );
  }

  const url = rawUrl ? normalizeUrl(rawUrl) : null;
  if (rawUrl && !url) {
    return Response.json({ error: "invalid_url" }, { status: 400 });
  }

  const clientExtracted =
    body.clientExtracted && typeof body.clientExtracted === "object"
      ? (body.clientExtracted as ClientExtracted)
      : null;

  let capturedAt: string | null = null;
  if (typeof body.capturedAt === "string" && !Number.isNaN(Date.parse(body.capturedAt))) {
    capturedAt = new Date(body.capturedAt).toISOString();
  }

  // dedupe: same normalized URL → bump seen_count, keep the original
  if (url) {
    const find = await sb(`items?url_hash=eq.${urlHash(url)}&select=id,seen_count&limit=1`);
    const existing = (await find.json().catch(() => null)) as Array<{
      id: string;
      seen_count: number;
    }> | null;
    if (find.ok && existing?.length) {
      const dup = existing[0];
      const patch = await sb(`items?id=eq.${dup.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          seen_count: dup.seen_count + 1,
          last_seen_at: new Date().toISOString(),
        }),
      });
      if (!patch.ok) {
        return Response.json(
          { error: "db_error", detail: sbErrorMessage(patch, await patch.json().catch(() => null)) },
          { status: 500 }
        );
      }
      return Response.json({ ok: true, saved: "existing", id: dup.id });
    }
  }
  const title = cap(str(body.title) || str(clientExtracted?.title), 300);  const row: Record<string, unknown> = {
    url,
    url_hash: url ? urlHash(url) : null,
    kind: url ? "link" : "text",
    platform: url ? detectPlatform(url) : null,
    raw_text: cap(text, 5000),
    title,
    description: cap(str(clientExtracted?.description), 600),
    thumbnail_url: cap(str(clientExtracted?.image), 2000),
    status: "pending",
    // device-assisted enrichment (hybrid model): the phone's extraction
    // result ships with the capture so the server skips re-fetching
    enrichment_level: clientExtracted
      ? str(clientExtracted.image)
        ? "full_device"
        : "metadata"
      : url
        ? "url_only"
        : "none",
    ...(capturedAt ? { created_at: capturedAt, last_seen_at: capturedAt } : {}),
  };

  const insert = await sb("items", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(row),
  });
  const inserted = (await insert.json().catch(() => null)) as Array<Record<string, unknown>> | null;
  if (!insert.ok || !inserted?.length) {
    return Response.json(
      { error: "db_error", detail: sbErrorMessage(insert, inserted) },
      { status: 500 }
    );
  }
  const created = inserted[0];

  // Phase ③ + ④: enrichment then the AI pass run after the response is sent
  // — the capture returns in ~100ms and the item fills in over the next
  // ~10-20s. Both are idempotent + guarded; failures leave retry paths.
  after(async () => {
    try {
      await enrichItem(String(created.id));
    } catch {
      // sweep/retry paths recover anything that ends up stale
    }
    try {
      // vision first — the category decision should see the picture
      await visionPassItem(String(created.id));
    } catch {
      // thumbnails that won't download just skip the pass
    }
    try {
      await aiEnrichItem(String(created.id));
    } catch {
      // no key configured, quota exhausted — item stays uncategorized
    }
  });

  return Response.json({ ok: true, saved: "created", item: created }, { status: 201 });
}

/**
 * GET /api/captures?state=&limit= — newest-first feed.
 * (Cursor pagination arrives with the web triage UI.)
 */
export async function GET(req: Request) {
  if (!checkAuth(req)) return unauthorized();
  if (!supabaseConfigured()) {
    return Response.json({ error: "supabase_not_configured" }, { status: 503 });
  }

  const params = new URL(req.url).searchParams;
  const limitRaw = Number.parseInt(params.get("limit") ?? "50", 10);
  const limit = Number.isNaN(limitRaw) ? 50 : Math.min(Math.max(limitRaw, 1), 200);
  const state = params.get("state");

  const query = new URLSearchParams({
    // embed the item's category (FK items.category_id → categories.id) so
    // clients can group by category without a second request
    select: "*,categories(id,name,color)",
    order: "created_at.desc",
    limit: String(limit),
  });
  if (state && STATES.has(state)) query.set("state", `eq.${state}`);

  const res = await sb(`items?${query.toString()}`);
  const items = await res.json().catch(() => null);
  if (!res.ok) {
    return Response.json(
      { error: "db_error", detail: sbErrorMessage(res, items) },
      { status: 500 }
    );
  }
  return Response.json({ ok: true, items });
}
