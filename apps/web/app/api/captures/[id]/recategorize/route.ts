import { checkAuth, unauthorized } from "@/lib/auth";
import { supabaseConfigured } from "@/lib/env";
import { sb, sbErrorMessage } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/captures/:id/recategorize — one-tap manual correction.
 * Body: {category_id: "<uuid>" | null}  (null = clear to uncategorized)
 * Sets category_source=manual (the AI never overrides it) and records a
 * feedback_event that steers future AI categorization.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!checkAuth(req)) return unauthorized();
  if (!supabaseConfigured()) {
    return Response.json({ error: "supabase_not_configured" }, { status: 503 });
  }
  const { id } = await params;
  if (!UUID.test(id)) return Response.json({ error: "invalid_id" }, { status: 400 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const categoryId = body.category_id === null ? null : body.category_id;
  if (categoryId !== null && (typeof categoryId !== "string" || !UUID.test(categoryId))) {
    return Response.json({ error: "invalid_category_id" }, { status: 400 });
  }

  let categoryName: string | null = null;
  if (categoryId) {
    const catRes = await sb(`categories?id=eq.${categoryId}&select=name&limit=1`);
    const cats = (await catRes.json().catch(() => null)) as Array<{ name: string }> | null;
    if (!catRes.ok || !cats?.length) {
      return Response.json({ error: "category_not_found" }, { status: 404 });
    }
    categoryName = cats[0].name;
  }

  const patch = await sb(`items?id=eq.${id}`, {
    method: "PATCH",
    body: JSON.stringify({
      category_id: categoryId,
      category_source: categoryId ? "manual" : "none",
      category_confidence: null,
    }),
  });
  if (!patch.ok) {
    return Response.json(
      { error: "db_error", detail: sbErrorMessage(patch, await patch.json().catch(() => null)) },
      { status: 500 }
    );
  }

  await sb("feedback_events", {
    method: "POST",
    body: JSON.stringify({
      item_id: id,
      kind: "recategorize",
      payload: { category_id: categoryId, category_name: categoryName },
    }),
  });

  return Response.json({ ok: true, category_id: categoryId, category_name: categoryName });
}
