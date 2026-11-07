import { checkAuth, unauthorized } from "@/lib/auth";
import { supabaseConfigured } from "@/lib/env";
import { sb, sbErrorMessage } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/** DELETE /api/captures/:id — remove one item (phone delete sync). */
export async function DELETE(
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

  const res = await sb(`items?id=eq.${id}`, { method: "DELETE" });
  if (!res.ok) {
    return Response.json(
      { error: "db_error", detail: sbErrorMessage(res, await res.json().catch(() => null)) },
      { status: 500 }
    );
  }
  return Response.json({ ok: true });
}
