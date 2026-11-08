import { enrichItem } from "@/lib/enrich";
import { sb, sbErrorMessage } from "@/lib/supabase";

export const dynamic = "force-dynamic";
// Hobby max with Fluid Compute — the sweep enriches a batch of 10 within it
export const maxDuration = 300;

/**
 * Daily cron (vercel.json): re-run enrichment for stale pending/failed items
 * and heartbeat-write Supabase so the free project never pauses.
 *
 * Auth: Vercel automatically sends `Authorization: Bearer $CRON_SECRET` when
 * that env var is set; manual curls must send the same header. Fail closed.
 */
async function sweep(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return Response.json(
      { error: "cron_not_configured", hint: "set CRON_SECRET in Vercel env vars" },
      { status: 401 }
    );
  }
  const m = /^Bearer\s+(.+?)\s*$/i.exec(req.headers.get("authorization") ?? "");
  if (!m || m[1] !== secret) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  // items that never finished enriching, oldest first, small batch.
  // (Two plain queries — nested and()/or() logic trees parse unreliably.)
  const cutoff = new Date(Date.now() - 86400_000).toISOString();
  const base = "select=id,url,status&status=in.(pending,failed)&order=created_at.asc&limit=10";
  const [neverTried, staleTried] = await Promise.all([
    sb(`items?${base}&enriched_at=is.null`),
    sb(`items?${base}&enriched_at=lt."${cutoff}"`),
  ]);
  const neverRows = (await neverTried.json().catch(() => null)) as
    | Array<{ id: string; url: string | null; status: string }>
    | null;
  const staleRows = (await staleTried.json().catch(() => null)) as
    | Array<{ id: string; url: string | null; status: string }>
    | null;
  if (!neverTried.ok || !staleTried.ok || !neverRows || !staleRows) {
    return Response.json(
      { error: "db_error", detail: sbErrorMessage(neverTried.ok ? staleTried : neverTried, null) },
      { status: 500 }
    );
  }
  const byId = new Map<string, { id: string; url: string | null; status: string }>();
  for (const row of [...neverRows, ...staleRows]) byId.set(row.id, row);
  const stale = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)).slice(0, 10);

  const results: Array<{ id: string; level: string; status: string }> = [];
  for (const item of stale) {
    try {
      const r = await enrichItem(item.id);
      if (r) results.push({ id: item.id, level: r.level, status: r.status });
    } catch {
      // keep sweeping the rest
    }
  }

  // heartbeat: a write counts as activity for Supabase's pause timer
  await sb(`fetch_cache?on_conflict=url_hash`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({
      url_hash: "__heartbeat__",
      provider: "heartbeat",
      payload: { at: new Date().toISOString() },
      fetched_at: new Date().toISOString(),
    }),
  });

  return Response.json({
    ok: true,
    swept: stale.length,
    results,
    time: new Date().toISOString(),
  });
}

export async function GET(req: Request) {
  return sweep(req);
}

export async function POST(req: Request) {
  return sweep(req);
}
