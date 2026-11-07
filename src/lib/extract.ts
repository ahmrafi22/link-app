import AsyncStorage from "@react-native-async-storage/async-storage";

import { detectPlatform, normalizeUrl, type VaultItem } from "./store";

/**
 * On-device extraction — the device-assisted half of the plan's hybrid model.
 * The phone has a residential IP, so it can fetch what a datacenter server
 * cannot (Reddit JSON, many OG tags). Everything is size-capped and cached;
 * the server later merges these fields with its own waterfall.
 *
 * No anti-bot evasion, no login-walled content: X/Instagram/Facebook are
 * expected to stay `url_only` here.
 */

export type EnrichmentLevel = "full" | "metadata" | "url_only";

export type ExtractResult = {
  title: string | null;
  description: string | null;
  thumbnailUrl: string | null;
  siteName: string | null;
  meta: Record<string, string | number> | null;
  level: EnrichmentLevel;
};

export type ExtractOutcome =
  | { status: "done"; result: ExtractResult }
  /** Network failure (offline, DNS…): leave the item pending, retry later. */
  | { status: "failed" }
  /** Timed out: counts against the per-item attempt budget. */
  | { status: "timeout" };

const CACHE_KEY = "linkvault.extractcache.v1";
const DAY_MS = 24 * 60 * 60 * 1000;
/** Successful extractions are re-fetched after a week (plan: server keeps 30d). */
const FRESH_MS = 7 * DAY_MS;
/** url_only results are cheap failures — retry again tomorrow. */
const NEGATIVE_FRESH_MS = 1 * DAY_MS;
const MAX_ATTEMPTS = 5;
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 600;
const MAX_HTML = 400_000;

const BROWSER_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

async function fetchText(
  url: string,
  headers: Record<string, string>,
  timeoutMs = 7000
): Promise<{ ok: true; text: string } | { ok: false; timeout: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) return { ok: false, timeout: false };
    const type = res.headers.get("content-type") ?? "";
    if (!/text\/html|application\/json|text\/plain/.test(type)) {
      return { ok: false, timeout: false };
    }
    const text = await res.text();
    return { ok: true, text: text.slice(0, MAX_HTML) };
  } catch {
    // abort() surfaces as AbortError; signal.aborted distinguishes it from
    // genuine network failures (offline → false)
    return { ok: false, timeout: controller.signal.aborted };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(
  url: string,
  timeoutMs = 7000
): Promise<any | null> {
  const res = await fetchText(
    url,
    { "User-Agent": BROWSER_UA, Accept: "application/json" },
    timeoutMs
  );
  if (!res.ok) return null;
  try {
    return JSON.parse(res.text);
  } catch {
    return null;
  }
}

function cap(s: string | null | undefined, max: number): string | null {
  if (!s) return null;
  const t = s.trim();
  if (!t) return null;
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&#x27;/gi, "'")
    .replace(/&nbsp;/gi, " ");
}

function matchAttr(tag: string, attr: string): string | null {
  const m = tag.match(new RegExp(`${attr}\\s*=\\s*["']([^"']*)["']`, "i"));
  return m ? m[1] : null;
}

/** Minimal OG/Twitter-card extractor — regex-based, no dependencies. */
function metaTags(html: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = matchAttr(tag, "property") ?? matchAttr(tag, "name");
    const content = matchAttr(tag, "content");
    if (key && content != null && !map.has(key.toLowerCase())) {
      map.set(key.toLowerCase(), decodeEntities(content).trim());
    }
  }
  return map;
}

function extractFromHtml(html: string, baseUrl: string): ExtractResult {
  const m = metaTags(html);
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title =
    m.get("og:title") ?? m.get("twitter:title") ?? decodeEntities(titleMatch?.[1] ?? "");
  const description =
    m.get("og:description") ??
    m.get("twitter:description") ??
    m.get("description") ??
    null;
  const rawImage =
    m.get("og:image:secure_url") ?? m.get("og:image") ?? m.get("twitter:image") ?? m.get("twitter:image:src");
  let thumbnailUrl: string | null = null;
  if (rawImage) {
    try {
      const abs = new URL(decodeEntities(rawImage), baseUrl);
      if (/^https?:$/.test(abs.protocol)) thumbnailUrl = abs.toString();
    } catch {
      // keep null
    }
  }
  const siteName = m.get("og:site_name") ?? null;
  const hasSomething = !!(title || description || thumbnailUrl);
  return {
    title: cap(title, MAX_TITLE),
    description: cap(description, MAX_DESCRIPTION),
    thumbnailUrl,
    siteName: cap(siteName, 100),
    meta: null,
    level: hasSomething ? "metadata" : "url_only",
  };
}

type PlatformResult = Omit<ExtractResult, "level">;

async function fetchYouTubeOEmbed(url: string): Promise<PlatformResult | null> {
  const j = await fetchJson(
    `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`
  );
  if (!j?.title) return null;
  return {
    title: cap(j.title, MAX_TITLE),
    description: null,
    thumbnailUrl: typeof j.thumbnail_url === "string" ? j.thumbnail_url : null,
    siteName: "YouTube",
    meta: j.author_name ? { author: j.author_name } : null,
  };
}

async function fetchRedditJson(url: string): Promise<PlatformResult | null> {
  const base = url.split("?")[0].replace(/\/+$/, "");
  if (!/reddit\.com$|redd\.it$/.test(new URL(url).hostname)) return null;
  const j = await fetchJson(`${base}.json`);
  const post = j?.[0]?.data?.children?.find((c: any) => c?.data)?.data;
  if (!post?.title) return null;
  const preview = post.preview?.images?.[0]?.source?.url;
  const thumb =
    (typeof preview === "string" && decodeEntities(preview).startsWith("http")
      ? decodeEntities(preview)
      : null) ??
    (typeof post.thumbnail === "string" && post.thumbnail.startsWith("http")
      ? post.thumbnail
      : null);
  return {
    title: cap(post.title, MAX_TITLE),
    description: cap(post.selftext, MAX_DESCRIPTION),
    thumbnailUrl: thumb,
    siteName: "Reddit",
    meta: {
      ...(post.subreddit_name_prefixed ? { subreddit: post.subreddit_name_prefixed } : {}),
      ...(typeof post.score === "number" ? { score: post.score } : {}),
      ...(typeof post.num_comments === "number" ? { comments: post.num_comments } : {}),
    },
  };
}

async function fetchTikTokOEmbed(url: string): Promise<PlatformResult | null> {
  const j = await fetchJson(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`);
  if (!j?.title) return null;
  return {
    title: cap(j.title, MAX_TITLE),
    description: null,
    thumbnailUrl: typeof j.thumbnail_url === "string" ? j.thumbnail_url : null,
    siteName: "TikTok",
    meta: j.author_name ? { author: j.author_name } : null,
  };
}

async function fetchGitHubApi(url: string): Promise<PlatformResult | null> {
  const m = url.match(/^https?:\/\/github\.com\/([^/?#]+)\/([^/?#]+)/i);
  if (!m) return null;
  const j = await fetchJson(
    `https://api.github.com/repos/${m[1]}/${m[2].replace(/\.git$/, "")}`
  );
  if (!j?.full_name) return null;
  return {
    title: cap(j.full_name, MAX_TITLE),
    description: cap(j.description, MAX_DESCRIPTION),
    thumbnailUrl: null,
    siteName: "GitHub",
    meta: {
      ...(typeof j.stargazers_count === "number" ? { stars: j.stargazers_count } : {}),
      ...(j.language ? { language: j.language } : {}),
    },
  };
}

// ---- cache ---------------------------------------------------------------

type CacheEntry = { at: number; result: ExtractResult };

async function readCache(): Promise<Record<string, CacheEntry>> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

async function writeCache(cache: Record<string, CacheEntry>): Promise<void> {
  try {
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // cache is best-effort
  }
}

function isFresh(entry: CacheEntry): boolean {
  const ttl = entry.result.level === "url_only" ? NEGATIVE_FRESH_MS : FRESH_MS;
  return Date.now() - entry.at < ttl;
}

// ---- public API -----------------------------------------------------------

/**
 * Extract everything possible for one link. Returns `done` with a patch-able
 * result, `timeout` (counts an attempt), or `failed` (transient network).
 */
export async function extractForUrl(
  url: string,
  opts: { force?: boolean } = {}
): Promise<ExtractOutcome> {
  const urlKey = normalizeUrl(url) ?? url;

  if (!opts.force) {
    const cache = await readCache();
    const hit = cache[urlKey];
    if (hit && isFresh(hit)) return { status: "done", result: hit.result };
  }

  let result: ExtractResult | null = null;
  const platform = detectPlatform(url);

  try {
    if (platform === "youtube") result = await fetchYouTubeOEmbed(url);
    else if (platform === "reddit") result = await fetchRedditJson(url);
    else if (platform === "tiktok") result = await fetchTikTokOEmbed(url);
    else if (platform === "github") result = await fetchGitHubApi(url);

    if (!result) {
      const html = await fetchText(url, {
        "User-Agent": BROWSER_UA,
        Accept: "text/html,application/xhtml+xml",
      });
      if (html.ok) {
        const og = extractFromHtml(html.text, url);
        result = { ...og };
      } else if (html.timeout) {
        return { status: "timeout" };
      }
    }
  } catch {
    // network-level failure (offline etc.) — treat as transient
    return { status: "failed" };
  }

  if (!result) return { status: "done", result: emptyResult() };

  const cache = await readCache();
  cache[urlKey] = { at: Date.now(), result };
  await writeCache(cache);
  return { status: "done", result };
}

function emptyResult(): ExtractResult {
  return {
    title: null,
    description: null,
    thumbnailUrl: null,
    siteName: null,
    meta: null,
    level: "url_only",
  };
}

/** Links that should be (re-)extracted right now. */
export function selectEnrichTargets(items: VaultItem[]): VaultItem[] {
  const now = Date.now();
  return items.filter((item) => {
    if (item.kind !== "link" || !item.url) return false;
    if ((item.enrichAttempts ?? 0) >= MAX_ATTEMPTS) return false;
    if (!item.enrichmentLevel || !item.enrichedAt) return true;
    const age = now - new Date(item.enrichedAt).getTime();
    if (Number.isNaN(age)) return true;
    return item.enrichmentLevel === "url_only"
      ? age >= NEGATIVE_FRESH_MS
      : age >= FRESH_MS;
  });
}

/** Run extraction over a list of targets, 3 at a time. Returns store patches. */
export async function enrichLinks(
  targets: VaultItem[]
): Promise<Array<{ id: string; patch: Partial<VaultItem> }>> {
  const updates: Array<{ id: string; patch: Partial<VaultItem> }> = [];
  const queue = [...targets];

  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift()!;
      const outcome = await extractForUrl(item.url!);
      if (outcome.status === "done") {
        updates.push({
          id: item.id,
          patch: {
            title: item.title ?? outcome.result.title,
            description: outcome.result.description,
            thumbnailUrl: outcome.result.thumbnailUrl,
            siteName: outcome.result.siteName,
            meta: outcome.result.meta,
            enrichmentLevel: outcome.result.level,
            enrichedAt: new Date().toISOString(),
            enrichAttempts: 0,
          },
        });
      } else if (outcome.status === "timeout") {
        updates.push({
          id: item.id,
          patch: { enrichAttempts: (item.enrichAttempts ?? 0) + 1 },
        });
      }
      // "failed" → no patch; retried on the next open
    }
  }

  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker));
  return updates;
}
