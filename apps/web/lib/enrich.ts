import { cap, detectPlatform, urlHash } from "./normalize";
import { sb } from "./supabase";

/**
 * Phase ③ — server enrichment waterfall. Runs post-response via after() and
 * from the daily cron. Waterfall per PLAN.md: platform fetcher → oEmbed →
 * OG/Twitter meta (+ paragraph text extraction), 6 s per step, one attempt
 * per source, successes cached 30 days in fetch_cache (errors 1 day so the
 * cron retries without hammering).
 *
 * Ethics: no anti-bot evasion, never scrape login-walled content. The link
 * -preview UA (facebookexternalhit) is the platforms' own sanctioned
 * pathway for unfurlers — Instagram/Facebook usually still degrade, and the
 * phone's client-extracted data stays primary (this server only fills gaps).
 */

const UA_BROWSER =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const UA_PREVIEW =
  "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";

const STEP_TIMEOUT = 6000;
const FRESH_MS = 30 * 86400_000;
const NEGATIVE_MS = 1 * 86400_000;
const MAX_HTML = 600_000;
const MAX_TEXT = 15_000;

export type EnrichResult = {
  title: string | null;
  description: string | null;
  thumbnailUrl: string | null;
  siteName: string | null;
  extractedText: string | null;
  meta: Record<string, string | number> | null;
  provider: string;
};

type Fetched =
  | { ok: true; text: string; status: number }
  | { ok: false; timeout: boolean; status: number | null };

async function fetchText(
  url: string,
  headers: Record<string, string>,
  timeoutMs = STEP_TIMEOUT
): Promise<Fetched> {
  try {
    const res = await fetch(url, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, timeout: false, status: res.status };
    const text = await res.text();
    return { ok: true, text: text.slice(0, MAX_HTML), status: res.status };
  } catch (err) {
    return {
      ok: false,
      timeout: err instanceof Error && err.name === "TimeoutError",
      status: null,
    };
  }
}

async function fetchJson(url: string, headers?: Record<string, string>): Promise<any | null> {
  const res = await fetchText(url, { Accept: "application/json", ...headers });
  if (!res.ok) return null;
  try {
    return JSON.parse(res.text);
  } catch {
    return null;
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&");
}

function safeCodePoint(n: number): string {
  return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
}

function metaTagValue(html: string, keys: string[]): string | null {
  const tags = html.match(/<meta\s+[^>]*>/gi) ?? [];
  const wanted = new Set(keys.map((k) => k.toLowerCase()));
  for (const tag of tags) {
    const key = /(?:property|name)\s*=\s*"([^"]*)"/i.exec(tag)?.[1]?.toLowerCase();
    if (!key || !wanted.has(key)) continue;
    const content = /content\s*=\s*"([^"]*)"/i.exec(tag)?.[1];
    if (content && content.trim()) return decodeEntities(content.trim());
  }
  return null;
}

/** og/twitter/description meta extraction from raw HTML. */
function extractFromHtml(html: string): Omit<EnrichResult, "provider" | "extractedText"> & {
  extractedText: string | null;
} {
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? null;
  return {
    title: cap(
      metaTagValue(html, ["og:title", "twitter:title"]) ??
        (titleTag ? decodeEntities(titleTag).trim() : null),
      300
    ),
    description: cap(
      metaTagValue(html, ["og:description", "twitter:description", "description"]),
      600
    ),
    thumbnailUrl: metaTagValue(html, ["og:image", "og:image:secure_url", "twitter:image"]),
    siteName: cap(metaTagValue(html, ["og:site_name"]), 100),
    extractedText: extractParagraphs(html),
    meta: null,
  };
}

/** Readability-lite: paragraphs only, no dependencies, capped for embeddings. */
function extractParagraphs(html: string): string | null {
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  const paras = (cleaned.match(/<p\b[^>]*>([\s\S]*?)<\/p>/gi) ?? [])
    .map((p) =>
      decodeEntities(
        p
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
      )
    )
    .filter((t) => t.length >= 40);
  if (paras.length === 0) return null;
  return cap(paras.join("\n"), MAX_TEXT);
}

// ---- platform fetchers -----------------------------------------------------

async function youTubeOEmbed(url: string): Promise<EnrichResult | null> {
  const j = await fetchJson(
    `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`
  );
  if (!j?.title) return null;
  return {
    title: cap(j.title, 300),
    description: null,
    thumbnailUrl: j.thumbnail_url ?? null,
    siteName: "YouTube",
    extractedText: null,
    meta: j.author_name ? { channel: j.author_name } : null,
    provider: "youtube-oembed",
  };
}

async function githubApi(url: string): Promise<EnrichResult | null> {
  const m = /github\.com\/([\w.-]+)\/([\w.-]+)/i.exec(url);
  if (!m) return null;
  const j = await fetchJson(`https://api.github.com/repos/${m[1]}/${m[2].replace(/\.git$/, "")}`);
  if (!j?.full_name) return null;
  const meta: Record<string, string | number> = {};
  if (typeof j.stargazers_count === "number") meta.stars = j.stargazers_count;
  if (j.language) meta.language = j.language;
  if (typeof j.forks_count === "number") meta.forks = j.forks_count;
  return {
    title: cap(j.full_name, 300),
    description: cap(j.description, 600),
    thumbnailUrl: j.owner?.avatar_url ?? null,
    siteName: "GitHub",
    extractedText: null,
    meta: Object.keys(meta).length ? meta : null,
    provider: "github-api",
  };
}

async function xViaFixTweet(url: string): Promise<EnrichResult | null> {
  const m = /(?:x|twitter)\.com\/(\w{1,20})\/status\/(\d+)/i.exec(url);
  if (!m) return null;
  const j = await fetchJson(`https://api.fxtwitter.com/i/status/${m[2]}`);
  const tweet = j?.tweet;
  if (!tweet) return null;
  const meta: Record<string, string | number> = { author: tweet.author?.screen_name ?? m[1] };
  if (typeof tweet.likes === "number") meta.likes = tweet.likes;
  if (typeof tweet.retweets === "number") meta.reposts = tweet.retweets;
  return {
    title: cap(tweet.text, 300),
    description: null,
    thumbnailUrl: tweet.media?.photos?.[0]?.url ?? tweet.media?.videos?.[0]?.thumbnail_url ?? null,
    siteName: "X",
    extractedText: null,
    meta,
    provider: "fxtwitter",
  };
}

async function xOEmbed(url: string): Promise<EnrichResult | null> {
  const j = await fetchJson(`https://publish.x.com/oembed?url=${encodeURIComponent(url)}`);
  if (!j) return null;
  return {
    title: cap(j.title ?? j.author_name, 300),
    description: null,
    thumbnailUrl: null,
    siteName: "X",
    extractedText: null,
    meta: j.author_name ? { author: j.author_name } : null,
    provider: "x-oembed",
  };
}

async function tikTokOEmbed(url: string): Promise<EnrichResult | null> {
  const j = await fetchJson(
    `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`
  );
  if (!j?.title) return null;
  return {
    title: cap(j.title, 300),
    description: null,
    thumbnailUrl: j.thumbnail_url ?? null,
    siteName: "TikTok",
    extractedText: null,
    meta: j.author_name ? { author: j.author_name } : null,
    provider: "tiktok-oembed",
  };
}

async function redditJson(url: string): Promise<EnrichResult | null> {
  // best-effort only — Reddit 403s datacenter IPs; OG tags are the primary
  const res = await fetchText(url.replace(/\/?(\?.*)?$/, "") + ".json", {
    "User-Agent": UA_BROWSER,
    Accept: "application/json",
  });
  if (!res.ok) return null;
  try {
    const j = JSON.parse(res.text);
    const post = j?.[0]?.data?.children?.[0]?.data;
    if (!post) return null;
    const meta: Record<string, string | number> = {};
    if (post.subreddit) meta.subreddit = `r/${post.subreddit}`;
    if (typeof post.score === "number") meta.score = post.score;
    if (typeof post.num_comments === "number") meta.comments = post.num_comments;
    return {
      title: cap(post.title, 300),
      description: cap(post.selftext, 600),
      thumbnailUrl: post.preview?.images?.[0]?.source?.url?.replace(/&amp;/g, "&") ?? null,
      siteName: "Reddit",
      extractedText: null,
      meta: Object.keys(meta).length ? meta : null,
      provider: "reddit-json",
    };
  } catch {
    return null;
  }
}

async function ogFetch(url: string, ua: string, provider: string): Promise<EnrichResult | null> {
  const res = await fetchText(url, {
    "User-Agent": ua,
    Accept: "text/html,application/xhtml+xml",
  });
  if (!res.ok) return null;
  const og = extractFromHtml(res.text);
  if (!og.title && !og.thumbnailUrl && !og.description) return null;
  return { ...og, provider };
}

function score(r: EnrichResult | null): number {
  if (!r) return 0;
  let s =
    (r.title ? 1 : 0) +
    (r.description ? 1 : 0) +
    (r.thumbnailUrl ? 1 : 0) +
    (r.extractedText ? 1 : 0);
  // dedicated platform fetchers outrank generic OG even at equal richness —
  // e.g. fxtwitter (author + likes) beats X's own thin og tags
  if (!r.provider.startsWith("og")) s += 2;
  return s;
}

/** Run the per-platform waterfall; keep the richest result (≥3 fields wins). */
async function waterfall(url: string, platform: string | null): Promise<EnrichResult | null> {
  let steps: Array<() => Promise<EnrichResult | null>>;

  switch (platform) {
    case "youtube":
      steps = [
        () => youTubeOEmbed(url),
        () => ogFetch(url, UA_BROWSER, "og"),
      ];
      break;
    case "github":
      steps = [
        () => githubApi(url),
        () => ogFetch(url, UA_BROWSER, "og"),
      ];
      break;
    case "x":
      steps = [
        () => xViaFixTweet(url),
        () => xOEmbed(url),
        () => ogFetch(url, UA_PREVIEW, "og-preview"),
      ];
      break;
    case "reddit":
      steps = [
        () => ogFetch(url, UA_BROWSER, "og"),
        () => ogFetch(url, UA_PREVIEW, "og-preview"),
        () => redditJson(url),
      ];
      break;
    case "tiktok":
      steps = [
        () => tikTokOEmbed(url),
        () => ogFetch(url, UA_BROWSER, "og"),
      ];
      break;
    case "instagram":
    case "facebook":
    case "threads":
      steps = [
        () => ogFetch(url, UA_PREVIEW, "og-preview"),
        () => ogFetch(url, UA_BROWSER, "og"),
      ];
      break;
    default:
      steps = [
        () => ogFetch(url, UA_BROWSER, "og"),
        () => ogFetch(url, UA_PREVIEW, "og-preview"),
      ];
  }

  let best: EnrichResult | null = null;
  for (const step of steps) {
    try {
      const r = await step();
      if (r && (!best || score(r) > score(best))) best = r;
      if (best && score(best) >= 3) break;
    } catch {
      // one attempt per source — fall through to the next
    }
  }
  return best;
}

// ---- fetch_cache -----------------------------------------------------------

type CachedPayload = { result?: EnrichResult; error?: string };

/**
 * Returns the cached success (if fresh) and whether a negative entry is
 * still within its 1-day window — `skip` means "don't re-fetch upstream,
 * it just failed recently".
 */
async function readCache(urlHash: string): Promise<{ hit: EnrichResult | null; skip: boolean }> {
  const res = await sb(`fetch_cache?url_hash=eq.${urlHash}&select=payload,fetched_at&limit=1`);
  const rows = (await res.json().catch(() => null)) as
    | Array<{ payload: CachedPayload; fetched_at: string }>
    | null;
  const row = rows?.[0];
  if (!row) return { hit: null, skip: false };
  const age = Date.now() - new Date(row.fetched_at).getTime();
  if (row.payload.error) return { hit: null, skip: age < NEGATIVE_MS };
  if (age >= FRESH_MS) return { hit: null, skip: false };
  return { hit: row.payload.result ?? null, skip: true };
}

async function writeCache(
  urlHash: string,
  payload: CachedPayload,
  provider: string
): Promise<void> {
  await sb(`fetch_cache?on_conflict=url_hash`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({
      url_hash: urlHash,
      provider,
      payload,
      fetched_at: new Date().toISOString(),
    }),
  });
}

// ---- levels & apply --------------------------------------------------------

function rank(level: string | null | undefined): number {
  if (level === "full_device" || level === "full_server") return 3;
  if (level === "metadata") return 2;
  if (level === "url_only") return 1;
  return 0;
}

function levelOf(r: EnrichResult | null): "full_server" | "metadata" | "url_only" {
  if (!r) return "url_only";
  if (r.provider.startsWith("og") || r.provider.startsWith("error")) {
    return r.thumbnailUrl || r.extractedText ? "full_server" : r.title || r.description ? "metadata" : "url_only";
  }
  // dedicated platform fetchers count as full
  return r.title || r.thumbnailUrl ? "full_server" : "url_only";
}

/**
 * Enrich one item by id. Idempotent; safe to call repeatedly (cache +
 * level-rank guards). Fills gaps — device-extracted data is never downgraded.
 */
export async function enrichItem(id: string): Promise<{ level: string; status: string } | null> {
  const res = await sb(`items?id=eq.${id}&select=*`);
  const rows = (await res.json().catch(() => null)) as Array<Record<string, any>> | null;
  const item = rows?.[0];
  if (!item) return null;

  // notes have nothing to fetch
  if (!item.url) {
    await sb(`items?id=eq.${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "ready", enriched_at: new Date().toISOString() }),
    });
    return { level: item.enrichment_level ?? "none", status: "ready" };
  }

  // already enriched beyond what a re-fetch would prove — don't downgrade
  if (item.status === "ready" && rank(item.enrichment_level) >= 3) {
    return { level: item.enrichment_level, status: "ready" };
  }

  const hash = item.url_hash ?? urlHash(item.url);
  const cached = await readCache(hash);
  let result = cached.hit;
  if (!result && !cached.skip) {
    result = await waterfall(item.url, detectPlatform(item.url));
    if (result) {
      await writeCache(hash, { result }, result.provider);
    } else {
      await writeCache(hash, { error: "UPSTREAM_BROKEN" }, "error");
    }
  }

  const level =
    rank(levelOf(result)) >= rank(item.enrichment_level) ? levelOf(result) : item.enrichment_level;
  const patch: Record<string, unknown> = {
    title: item.title ?? result?.title ?? null,
    description: item.description ?? result?.description ?? null,
    thumbnail_url: item.thumbnail_url ?? result?.thumbnailUrl ?? null,
    extracted_text: result?.extractedText ?? item.extracted_text ?? null,
    enrichment_level: level,
    enriched_at: new Date().toISOString(),
    status: level === "url_only" ? "failed" : "ready",
  };
  if (result?.meta) patch.meta = result.meta;

  // `meta` needs migration 0003; if the column isn't there yet, apply the
  // enrichment anyway without it rather than failing the whole PATCH
  const wrote = await sb(`items?id=eq.${id}`, { method: "PATCH", body: JSON.stringify(patch) });
  if (!wrote.ok && patch.meta) {
    delete patch.meta;
    await sb(`items?id=eq.${id}`, { method: "PATCH", body: JSON.stringify(patch) });
  }
  return { level: String(level), status: String(patch.status) };
}
