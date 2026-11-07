import { appSecretConfigured, supabaseConfigured } from "@/lib/env";
import { sb, sbErrorMessage } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * Liveness + configuration report. Also the keep-alive target: it performs a
 * tiny read against Postgres when configured, which doubles as activity for
 * Supabase's free-tier pause timer.
 */
export async function GET() {
  let supabase: "not_configured" | "ok" | "error" = "not_configured";
  let detail: string | null = null;

  if (supabaseConfigured()) {
    try {
      const res = await sb("categories?select=id&limit=1");
      if (res.ok) {
        supabase = "ok";
      } else {
        supabase = "error";
        detail = sbErrorMessage(res, await res.json().catch(() => null));
      }
    } catch (err) {
      supabase = "error";
      detail = err instanceof Error ? err.message : "network error";
    }
  }

  return Response.json({
    ok: true,
    service: "linkvault-web",
    time: new Date().toISOString(),
    auth: appSecretConfigured() ? "configured" : "missing",
    supabase,
    ...(detail ? { supabaseDetail: detail } : {}),
  });
}
