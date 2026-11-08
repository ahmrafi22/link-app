import { aiEmbed } from "@/lib/ai";
import { checkAuth, unauthorized } from "@/lib/auth";
import { supabaseConfigured } from "@/lib/env";
import { sb } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * GET /api/search?q=&state= — hybrid search per PLAN.md: Postgres FTS +
 * pgvector cosine fused by the match_items() RPC (RRF). The query is embedded
 * when an AI key is configured (semantic branch); without one the RPC still
 * runs but only the lexical branch contributes. Returns the fused rows —
 * ranked by RRF score.
 */
export async function GET(req: Request) {
  if (!checkAuth(req)) return unauthorized();
  if (!supabaseConfigured()) {
    return Response.json({ error: "supabase_not_configured" }, { status: 503 });
  }
  const params = new URL(req.url).searchParams;
  const q = (params.get("q") ?? "").trim();
  const state = params.get("state");
  if (!q) return Response.json({ ok: true, items: [], mode: "empty_query" });

  const embedding = await aiEmbed(q);
  const rpc = await sb("rpc/match_items", {
    method: "POST",
    body: JSON.stringify({
      query_text: q,
      query_embedding: embedding, // null → only the FTS branch contributes
      match_count: 20,
      filter_state: state && ["inbox", "saved", "follow_up", "archived"].includes(state) ? state : null,
    }),
  });
  const rows = (await rpc.json().catch(() => null)) as
    | Array<{ id: string; title: string | null; platform: string | null; score: number }>
    | null;
  if (!rpc.ok || !rows) {
    return Response.json({ error: "db_error" }, { status: 500 });
  }

  // resolve category names for the fused ids
  const ids = rows.map((r) => `"${r.id}"`).join(",");
  let catByItem = new Map<string, string>();
  if (ids) {
    const res = await sb(
      `items?select=id,categories(name)&id=in.(${ids})`
    );
    const full = (await res.json().catch(() => null)) as
      | Array<{ id: string; categories: { name: string } | null }>
      | null;
    if (res.ok && full) {
      catByItem = new Map(full.map((f) => [f.id, f.categories?.name ?? null]).filter(
        (pair): pair is [string, string] => Boolean(pair[1])
      ));
    }
  }

  return Response.json({
    ok: true,
    mode: embedding ? "hybrid" : "fulltext",
    items: rows.map((r) => ({ ...r, category_name: catByItem.get(r.id) ?? null })),
  });
}
