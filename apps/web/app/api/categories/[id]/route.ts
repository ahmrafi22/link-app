import { checkAuth, unauthorized } from "@/lib/auth";
import { supabaseConfigured } from "@/lib/env";
import { cap } from "@/lib/normalize";
import { sb } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ctx = { params: Promise<{ id: string }> };

/** PATCH /api/categories/:id — rename / re-describe / recolor. */
export async function PATCH(req: Request, ctx: Ctx) {
  if (!checkAuth(req)) return unauthorized();
  if (!supabaseConfigured()) {
    return Response.json({ error: "supabase_not_configured" }, { status: 503 });
  }
  const { id } = await ctx.params;
  if (!UUID.test(id)) return Response.json({ error: "invalid_id" }, { status: 400 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const patch: Record<string, unknown> = {};
  if (typeof body.name === "string") {
    const name = body.name.trim();
    if (!name || name.length > 40) {
      return Response.json({ error: "name_1_to_40_chars" }, { status: 400 });
    }
    patch.name = name;
  }
  if (typeof body.description === "string") patch.description = cap(body.description, 200);
  if (typeof body.color === "string") patch.color = cap(body.color, 20);
  if (Object.keys(patch).length === 0) {
    return Response.json({ error: "nothing_to_update" }, { status: 400 });
  }

  const res = await sb(`categories?id=eq.${id}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(patch),
  });
  const updated = (await res.json().catch(() => null)) as Array<Record<string, unknown>> | null;
  if (!res.ok || !updated?.length) return Response.json({ error: "db_error" }, { status: 500 });

  if (typeof patch.name === "string") {
    await sb("feedback_events", {
      method: "POST",
      body: JSON.stringify({ kind: "rename", payload: { category_id: id, to: patch.name } }),
    });
  }
  return Response.json({ ok: true, category: updated[0] });
}

/** DELETE /api/categories/:id — remove it; items fall back to uncategorized. */
export async function DELETE(req: Request, ctx: Ctx) {
  if (!checkAuth(req)) return unauthorized();
  if (!supabaseConfigured()) {
    return Response.json({ error: "supabase_not_configured" }, { status: 503 });
  }
  const { id } = await ctx.params;
  if (!UUID.test(id)) return Response.json({ error: "invalid_id" }, { status: 400 });

  // items keep existing via ON DELETE SET NULL
  const res = await sb(`categories?id=eq.${id}`, { method: "DELETE" });
  if (!res.ok) return Response.json({ error: "db_error" }, { status: 500 });
  return Response.json({ ok: true });
}
