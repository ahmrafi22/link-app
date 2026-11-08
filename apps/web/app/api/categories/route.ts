import { checkAuth, unauthorized } from "@/lib/auth";
import { supabaseConfigured } from "@/lib/env";
import { cap } from "@/lib/normalize";
import { sb } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/** GET /api/categories — list with live item counts. */
export async function GET(req: Request) {
  if (!checkAuth(req)) return unauthorized();
  if (!supabaseConfigured()) {
    return Response.json({ error: "supabase_not_configured" }, { status: 503 });
  }
  const catsRes = await sb("categories?select=id,name,description,color,is_ai_created&order=name.asc");
  const cats = (await catsRes.json().catch(() => null)) as
    | Array<{ id: string; name: string; description: string | null; color: string | null; is_ai_created: boolean }>
    | null;
  if (!catsRes.ok || !cats) {
    return Response.json({ error: "db_error" }, { status: 500 });
  }
  const countsRes = await sb("items?category_id=not.is.null&select=category_id");
  const rows = (await countsRes.json().catch(() => null)) as Array<{ category_id: string }> | null;
  const counts = new Map<string, number>();
  for (const r of rows ?? []) counts.set(r.category_id, (counts.get(r.category_id) ?? 0) + 1);
  return Response.json({
    ok: true,
    categories: cats.map((c) => ({ ...c, count: counts.get(c.id) ?? 0 })),
  });
}

/** POST /api/categories — create a category manually. */
export async function POST(req: Request) {
  if (!checkAuth(req)) return unauthorized();
  if (!supabaseConfigured()) {
    return Response.json({ error: "supabase_not_configured" }, { status: 503 });
  }
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 40) {
    return Response.json({ error: "name_required_40_max" }, { status: 400 });
  }
  const create = await sb("categories?on_conflict=name", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({
      name,
      description: cap(typeof body.description === "string" ? body.description : null, 200),
      color: cap(typeof body.color === "string" ? body.color : null, 20),
      is_ai_created: false,
    }),
  });
  const created = (await create.json().catch(() => null)) as Array<Record<string, unknown>> | null;
  if (!create.ok || !created?.length) {
    return Response.json({ error: "db_error" }, { status: 500 });
  }
  return Response.json({ ok: true, category: created[0] }, { status: 201 });
}
