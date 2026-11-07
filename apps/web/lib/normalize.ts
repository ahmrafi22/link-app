import { createHash } from "node:crypto";

const TRACKING_KEYS = new Set([
  "si", "fbclid", "gclid", "ref_src", "ref_url", "spm", "scid",
  "_hsenc", "_hsmi", "mc_cid", "mc_eid",
]);
const TRACKING_PREFIXES = ["utm_", "igsh", "sc_", "trk_"];

/**
 * Normalize a shared URL: add a missing https://, drop the fragment,
 * strip tracking params. Returns null when the string is not a URL.
 */
export function normalizeUrl(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) {
    if (!/^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(s)) return null;
    s = `https://${s}`;
  }
  try {
    const u = new URL(s);
    if (!/^https?:$/.test(u.protocol)) return null;
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_KEYS.has(key) || TRACKING_PREFIXES.some((p) => key.startsWith(p))) {
        u.searchParams.delete(key);
      }
    }
    return u.toString();
  } catch {
    return null;
  }
}

/** sha256 of the normalized URL — the dedupe key on items. */
export function urlHash(normalizedUrl: string): string {
  return createHash("sha256").update(normalizedUrl).digest("hex");
}

const PLATFORM_MAP: Array<[RegExp, string]> = [
  [/(^|\.)x\.com$|(^|\.)twitter\.com$/, "x"],
  [/(^|\.)instagram\.com$/, "instagram"],
  [/(^|\.)facebook\.com$|(^|\.)fb\.watch$|(^|\.)fb\.com$/, "facebook"],
  [/(^|\.)youtube\.com$|(^|\.)youtu\.be$/, "youtube"],
  [/(^|\.)reddit\.com$/, "reddit"],
  [/(^|\.)tiktok\.com$/, "tiktok"],
  [/(^|\.)threads\.(net|com)$/, "threads"],
  [/(^|\.)pinterest\.[a-z.]+$/, "pinterest"],
  [/(^|\.)linkedin\.com$/, "linkedin"],
  [/(^|\.)github\.com$/, "github"],
];

export function detectPlatform(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "link";
  }
  for (const [re, name] of PLATFORM_MAP) if (re.test(host)) return name;
  return host;
}

export function cap(s: string | null | undefined, max: number): string | null {
  if (!s) return null;
  const t = s.trim();
  if (!t) return null;
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}
