import { aiProvider } from "@/lib/ai";
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

  // live AI probe: reports the provider's HTTP status so a bad key is
  // visible from the outside without exposing the key itself
  let aiProbe: string | null = null;
  const provider = aiProvider();
  if (provider === "gemini") {
    try {
      const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models", {
        headers: { "x-goog-api-key": process.env.GEMINI_API_KEY ?? "" },
        signal: AbortSignal.timeout(8000),
      });
      aiProbe = r.ok ? "ok" : `http_${r.status}`;
    } catch {
      aiProbe = "network_error";
    }
  } else if (provider === "openai") {
    aiProbe = "openai_no_probe"; // key format varies by provider; LLM calls are the test
  }

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
    ai: provider ?? "not_configured",
    aiProbe,
    ...(detail ? { supabaseDetail: detail } : {}),
  });
}
