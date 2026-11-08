import { checkAuth, unauthorized } from "@/lib/auth";
import { supabaseConfigured } from "@/lib/env";
import { sb } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** GET /api/captures/:id/related — vector neighbors (plan Phase ⑤). */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!checkAuth(req)) return unauthorized();
  if (!supabaseConfigured()) {
    return Response.json({ error: "supabase_not_configured" }, { status: 503 });
  }
  const { id } = await params;
  if (!UUID.test(id)) return Response.json({ error: "invalid_id" }, { status: 400 });

  const rpc = await sb("rpc/related_items", {
    method: "POST",
    body: JSON.stringify({ source_item: id, match_count: 8 }),
  });
  const rows = (await rpc.json().catch(() => null)) as
    | Array<{
        id: string;
        title: string | null;
        url: string | null;
        platform: string | null;
        similarity: number;
      }>
    | null;
  if (!rpc.ok || !rows) return Response.json({ error: "db_error" }, { status: 500 });
  return Response.json({ ok: true, items: rows });
}
