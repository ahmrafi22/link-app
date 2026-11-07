import { SUPABASE_KEY, SUPABASE_URL } from "./env";

/**
 * Thin PostgREST client over fetch — the service-role key bypasses RLS,
 * so every call must stay server-side (route handlers only).
 */
export function sb(path: string, init: RequestInit = {}, timeoutMs = 8000): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export function sbErrorMessage(res: Response, body: unknown): string {
  const msg =
    body && typeof body === "object" && "message" in body
      ? String((body as { message: unknown }).message)
      : `HTTP ${res.status}`;
  return msg;
}
