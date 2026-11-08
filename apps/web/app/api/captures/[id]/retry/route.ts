import { checkAuth, unauthorized } from "@/lib/auth";
import { enrichItem } from "@/lib/enrich";
import { supabaseConfigured } from "@/lib/env";
import { sb, sbErrorMessage } from "@/lib/supabase";

export const dynamic = "force-dynamic";
// a single waterfall is bounded (~3 fetch steps × 6 s) but leave headroom
export const maxDuration = 60;

/**
 * POST /api/captures/:id/retry — forced re-enrichment of one item (the
 * phone's retry button on server-failed items). Bypasses the negative
 * fetch_cache window; returns the fresh row so the client can patch locally.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!checkAuth(req)) return unauthorized();
  const { id } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return Response.json({ error: "invalid_id" }, { status: 400 });
  }
  if (!supabaseConfigured()) {
    return Response.json({ error: "supabase_not_configured" }, { status: 503 });
  }

  let result: { level: string; status: string } | null;
  try {
    result = await enrichItem(id, { force: true });
  } catch {
    return Response.json({ error: "enrich_failed" }, { status: 500 });
  }
  if (!result) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  const res = await sb(`items?id=eq.${id}&select=*&limit=1`);
  const rows = (await res.json().catch(() => null)) as Array<Record<string, unknown>> | null;
  if (!res.ok || !rows?.length) {
    return Response.json(
      { error: "db_error", detail: sbErrorMessage(res, rows) },
      { status: 500 }
    );
  }
  return Response.json({ ok: true, result, item: rows[0] });
}
