import { checkAuth, unauthorized } from "@/lib/auth";
import { supabaseConfigured } from "@/lib/env";
import { sb, sbErrorMessage } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/categories/:id/merge — body {into: "<uuid>"}.
 * Moves every item, deletes the source, records a merge feedback event so
 * future AI suggestions respect the consolidation.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!checkAuth(req)) return unauthorized();
  if (!supabaseConfigured()) {
    return Response.json({ error: "supabase_not_configured" }, { status: 503 });
  }
  const { id: fromId } = await params;
  if (!UUID.test(fromId)) return Response.json({ error: "invalid_id" }, { status: 400 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const intoId = typeof body.into === "string" ? body.into : "";
  if (!UUID.test(intoId) || intoId === fromId) {
    return Response.json({ error: "invalid_into" }, { status: 400 });
  }

  const namesRes = await sb(
    `categories?id=in.("${fromId}","${intoId}")&select=id,name`
  );
  const names = (await namesRes.json().catch(() => null)) as
    | Array<{ id: string; name: string }>
    | null;
  if (!namesRes.ok || !names || names.length < 2) {
    return Response.json({ error: "categories_not_found" }, { status: 404 });
  }
  const from = names.find((n) => n.id === fromId)!;
  const into = names.find((n) => n.id === intoId)!;

  const move = await sb(`items?category_id=eq.${fromId}`, {
    method: "PATCH",
    body: JSON.stringify({ category_id: intoId }),
  });
  if (!move.ok) {
    return Response.json(
      { error: "db_error", detail: sbErrorMessage(move, await move.json().catch(() => null)) },
      { status: 500 }
    );
  }
  const del = await sb(`categories?id=eq.${fromId}`, { method: "DELETE" });
  if (!del.ok) return Response.json({ error: "db_error" }, { status: 500 });

  await sb("feedback_events", {
    method: "POST",
    body: JSON.stringify({
      kind: "merge",
      payload: { from_name: from.name, into_name: into.name },
    }),
  });
  return Response.json({ ok: true, merged: from.name, into: into.name });
}
