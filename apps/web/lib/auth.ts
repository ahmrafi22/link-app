import { createHash, timingSafeEqual } from "node:crypto";
import { appSecretConfigured } from "./env";

export function unauthorized(): Response {
  return Response.json(
    { error: "unauthorized", hint: "Authorization: Bearer <APP_SECRET>" },
    { status: 401 }
  );
}

/**
 * Single shared-secret bearer check (the app has no user accounts in v1).
 * Both sides are hashed before comparing so the comparison is
 * length-independent and timing-safe.
 */
export function checkAuth(req: Request): boolean {
  if (!appSecretConfigured()) return false;
  const m = /^Bearer\s+(.+?)\s*$/i.exec(req.headers.get("authorization") ?? "");
  if (!m) return false;
  const given = createHash("sha256").update(m[1]).digest();
  const expected = createHash("sha256").update(process.env.APP_SECRET ?? "").digest();
  return timingSafeEqual(given, expected);
}
