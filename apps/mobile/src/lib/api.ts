import * as SecureStore from "expo-secure-store";

/**
 * Client for the Link Vault API (apps/web). The base URL and the APP_SECRET
 * bearer token are pasted once in Settings and stored in the device keychain
 * (expo-secure-store) — never in AsyncStorage, never in the repo.
 */
const KEY_API_BASE = "linkvault.apiBase";
const KEY_APP_SECRET = "linkvault.appSecret";

export type ApiConfig = { apiBase: string; appSecret: string };

export async function getApiConfig(): Promise<ApiConfig | null> {
  try {
    const [apiBase, appSecret] = await Promise.all([
      SecureStore.getItemAsync(KEY_API_BASE),
      SecureStore.getItemAsync(KEY_APP_SECRET),
    ]);
    if (!apiBase || !appSecret) return null;
    return { apiBase: apiBase.trim().replace(/\/+$/, ""), appSecret: appSecret.trim() };
  } catch {
    return null;
  }
}

export async function saveApiConfig(config: ApiConfig): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(KEY_API_BASE, config.apiBase.trim().replace(/\/+$/, "")),
    SecureStore.setItemAsync(KEY_APP_SECRET, config.appSecret.trim()),
  ]);
}

export async function clearApiConfig(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(KEY_API_BASE),
    SecureStore.deleteItemAsync(KEY_APP_SECRET),
  ]);
}

const TIMEOUT = Symbol("timeout");

/**
 * fetch with a race timeout. Invariant from extract.ts: never pass a
 * `signal` to fetch on RN Android release builds — race against a timer
 * instead, and swallow fetch rejections into `null` so the race loser can
 * never raise an unhandled rejection.
 */
async function timedFetch(
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number
): Promise<Response | null | typeof TIMEOUT> {
  const resPromise = fetch(url, init).catch(() => null);
  const winner = await Promise.race([
    resPromise,
    new Promise<typeof TIMEOUT>((resolve) => setTimeout(() => resolve(TIMEOUT), timeoutMs)),
  ]);
  return winner === TIMEOUT ? TIMEOUT : ((winner as Response | null));
}

async function apiFetch(
  config: ApiConfig,
  path: string,
  init: RequestInit = {},
  timeoutMs = 10000
): Promise<{ res: Response | null; timedOut: boolean }> {
  const out = await timedFetch(
    `${config.apiBase}${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${config.appSecret}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    },
    timeoutMs
  );
  if (out === TIMEOUT) return { res: null, timedOut: true };
  return { res: out, timedOut: false };
}

type Fail = { ok: false; error: string };

export type HealthReport = {
  ok: boolean;
  auth: string;
  supabase: string;
};

/** GET /api/health — also the Settings "test connection" probe. */
export async function testConnection(config: ApiConfig): Promise<HealthReport | Fail> {
  try {
    const { res, timedOut } = await apiFetch(config, "/api/health", { method: "GET" }, 8000);
    if (timedOut) return { ok: false, error: "timed out" };
    if (!res) return { ok: false, error: "network error" };
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, auth: body.auth, supabase: body.supabase };
  } catch {
    return { ok: false, error: "network error" };
  }
}

/** Row shape returned by GET/POST /api/captures (subset we consume). */
export type ApiItem = {
  id: string;
  url: string | null;
  kind: string;
  platform: string | null;
  raw_text: string | null;
  title: string | null;
  description: string | null;
  thumbnail_url: string | null;
  enrichment_level: string;
  status: string;
  seen_count: number;
  created_at: string;
  last_seen_at: string | null;
  /** embedded via FK when selecting *,categories(...) on GET */
  categories?: { id: string; name: string; color: string | null } | null;
};

export type CapturePayload = {
  url?: string;
  text?: string;
  title?: string;
  capturedAt?: string;
  clientExtracted?: {
    title?: string | null;
    description?: string | null;
    image?: string | null;
    source?: string;
  };
};

/** POST /api/captures — returns the server id either way (create or dedupe). */
export async function postCapture(
  config: ApiConfig,
  payload: CapturePayload
): Promise<{ ok: true; id: string; saved: "created" | "existing" } | Fail> {
  try {
    const { res, timedOut } = await apiFetch(
      config,
      "/api/captures",
      { method: "POST", body: JSON.stringify(payload) },
      12000
    );
    if (timedOut) return { ok: false, error: "timed out" };
    if (!res) return { ok: false, error: "network error" };
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.ok) {
      return { ok: false, error: body?.error ?? `HTTP ${res.status}` };
    }
    return {
      ok: true,
      id: body.saved === "existing" ? body.id : body.item.id,
      saved: body.saved,
    };
  } catch {
    return { ok: false, error: "network error" };
  }
}

/** GET /api/captures — newest-first pull (single page, limit ≤ 200). */
export async function getCaptures(
  config: ApiConfig,
  limit = 200
): Promise<{ ok: true; items: ApiItem[] } | Fail> {
  try {
    const { res, timedOut } = await apiFetch(
      config,
      `/api/captures?limit=${Math.min(Math.max(limit, 1), 200)}`,
      { method: "GET" },
      15000
    );
    if (timedOut) return { ok: false, error: "timed out" };
    if (!res) return { ok: false, error: "network error" };
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.ok) {
      return { ok: false, error: body?.error ?? `HTTP ${res.status}` };
    }
    return { ok: true, items: Array.isArray(body.items) ? body.items : [] };
  } catch {
    return { ok: false, error: "network error" };
  }
}

/**
 * POST /api/captures/:id/retry — forced server re-enrichment (retry button
 * on server-failed items). Returns the fresh row to patch locally.
 */
export async function retryCapture(
  config: ApiConfig,
  serverId: string
): Promise<{ ok: true; item: ApiItem } | Fail> {
  try {
    const { res, timedOut } = await apiFetch(
      config,
      `/api/captures/${serverId}/retry`,
      { method: "POST" },
      30000
    );
    if (timedOut) return { ok: false, error: "timed out" };
    if (!res) return { ok: false, error: "network error" };
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.ok) {
      return { ok: false, error: body?.error ?? `HTTP ${res.status}` };
    }
    return { ok: true, item: body.item as ApiItem };
  } catch {
    return { ok: false, error: "network error" };
  }
}

/** DELETE /api/captures/:id — server-side delete (tombstones keep pulls honest). */
export async function deleteCapture(config: ApiConfig, serverId: string): Promise<boolean> {
  try {
    const { res } = await apiFetch(
      config,
      `/api/captures/${serverId}`,
      { method: "DELETE" },
      8000
    );
    return Boolean(res && res.ok);
  } catch {
    return false;
  }
}
