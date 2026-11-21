import { cap, detectPlatform } from "./normalize";
import { sb } from "./supabase";

/**
 * Phase ⑦ — spoken-content transcripts for short-video platforms.
 * Each platform exposes its own auto-captions publicly (no login, no JS):
 *   TikTok    — page JSON `subtitleInfos[]` → signed WebVTT URLs
 *   Facebook  — reel page HTML embeds `"captions_url"` .srt URLs
 *   Instagram — (audio path lives in lib/instaAudio.ts, commit 4)
 *
 * Two load-bearing facts from the live research (2026-11-21, PLAN.md Phase ⑦):
 * 1. Bare curl gets 400s from Facebook — the FULL browser header set below is
 *    what makes the page (and its caption URLs) come back. Keep it verbatim.
 * 2. Signed caption URLs expire within hours — they are fetched immediately.
 *
 * Ethics: same rules as the rest of the waterfall — public, logged-out
 * content only, one attempt per source, silent null on anything else. The
 * item's own `transcript` column doubles as the memo (skip when set), so
 * there is no separate negative cache here.
 */

const UA_BROWSER =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// what a real navigation request sends — Facebook fingerprints these
export const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent": UA_BROWSER,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};

const PAGE_TIMEOUT = 15_000;
const CAPTION_TIMEOUT = 8_000;
const MAX_PAGE = 4_000_000; // FB reel pages run ~2.7MB
const MAX_TRANSCRIPT = 15_000;

async function fetchPage(
  url: string,
  headers: Record<string, string>
): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(PAGE_TIMEOUT),
    });
    if (!res.ok) return null;
    return (await res.text()).slice(0, MAX_PAGE);
  } catch {
    return null;
  }
}

async function fetchCaption(url: string, referer?: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA_BROWSER, ...(referer ? { Referer: referer } : {}) },
      redirect: "follow",
      signal: AbortSignal.timeout(CAPTION_TIMEOUT),
    });
    if (!res.ok) return null;
    const text = await res.text();
    return text.length > 0 && text.length < 2_000_000 ? text : null;
  } catch {
    return null;
  }
}

// ---- caption text extraction ------------------------------------------------

/** SRT: drop sequence numbers, `00:00:00,000 --> 00:00:00,000` lines, blanks. */
function srtToText(srt: string): string | null {
  const lines = srt
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^\d+$/.test(l) && !l.includes("-->"));
  const text = lines.join(" ").replace(/\s+/g, " ").trim();
  return text.length >= 20 ? cap(text, MAX_TRANSCRIPT) : null;
}

/** WebVTT: drop WEBVTT header, NOTE/STYLE blocks, timestamps, cue ids. */
function vttToText(vtt: string): string | null {
  const text = vtt
    .replace(/^WEBVTT[^\n]*\n/i, "")
    .replace(/NOTE[\s\S]*?\n\n/g, "")
    .replace(/STYLE[\s\S]*?\n\n/g, "")
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.includes("-->") && !/^\d+$/.test(l.trim()))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length >= 20 ? cap(text, MAX_TRANSCRIPT) : null;
}

// ---- TikTok -------------------------------------------------------------------

/** Deep-find every `subtitleInfos` array in a parsed JSON tree. */
function findSubtitleInfos(node: unknown, out: any[][]): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const v of node) findSubtitleInfos(v, out);
    return;
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === "subtitleInfos" && Array.isArray(v) && v.length) out.push(v as any[]);
    else findSubtitleInfos(v, out);
  }
}

export async function tiktokTranscript(url: string): Promise<string | null> {
  const html = await fetchPage(url, BROWSER_HEADERS);
  if (!html) return null;

  // the page embeds its whole state as JSON in one script tag
  const m = html.match(
    /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application\/json">([\s\S]*?)<\/script>/
  );
  if (!m) return null;
  let data: unknown;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return null;
  }

  const found: any[][] = [];
  findSubtitleInfos(data, found);
  const tracks = found.flat();
  if (!tracks.length) return null; // video simply has no ASR captions

  // prefer an English track, then any track with a fetchable URL
  const pick =
    tracks.find((t) => String(t?.LanguageCodeName ?? t?.languageCodeName ?? "").startsWith("en") && (t?.Url ?? t?.url)) ??
    tracks.find((t) => t?.Url ?? t?.url);
  const vttUrl = pick?.Url ?? pick?.url;
  if (typeof vttUrl !== "string" || !vttUrl.startsWith("https://")) return null;

  const vtt = await fetchCaption(vttUrl, "https://www.tiktok.com/");
  return vtt ? vttToText(vtt) : null;
}

// ---- Facebook -----------------------------------------------------------------

export async function facebookTranscript(url: string): Promise<string | null> {
  const html = await fetchPage(url, BROWSER_HEADERS);
  if (!html) return null;

  // every embedded caption file (JSON-escaped); the first that downloads wins
  const rawUrls = [...html.matchAll(/"captions_url":"((?:[^"\\]|\\.)*)"/g)]
    .map((m) => {
      try {
        return JSON.parse(`"${m[1]}"`) as string;
      } catch {
        return null;
      }
    })
    .filter((u): u is string => typeof u === "string" && u.startsWith("https://"));
  if (!rawUrls.length) return null;

  for (const srtUrl of rawUrls.slice(0, 3)) {
    const srt = await fetchCaption(srtUrl, "https://www.facebook.com/");
    const text = srt ? srtToText(srt) : null;
    if (text) return text;
  }
  return null;
}

// ---- item-level pass ------------------------------------------------------------

/**
 * Fill `items.transcript` for one item. Idempotent: skips when the transcript
 * is already stored, when the platform has no transcript path, or when the
 * column doesn't exist yet (migration 0005 pending).
 */
export async function transcriptPassItem(id: string): Promise<{ done: boolean }> {
  try {
    const res = await sb(`items?id=eq.${id}&select=id,url,platform,transcript&limit=1`);
    const rows = (await res.json().catch(() => null)) as
      | Array<{ url: string | null; platform: string | null; transcript: string | null }>
      | null;
    const item = rows?.[0];
    if (!item?.url || item.transcript) return { done: false };

    const platform = item.platform ?? detectPlatform(item.url);
    let text: string | null = null;
    if (platform === "tiktok") text = await tiktokTranscript(item.url);
    else if (platform === "facebook") text = await facebookTranscript(item.url);
    else if (platform === "instagram") {
      // audio path (ffmpeg + Gemini) — lazy import keeps the binary out of
      // every route's bundle except where the pass actually runs
      const { instagramAudioTranscript } = await import("./instaAudio");
      text = await instagramAudioTranscript(item.url);
    }
    if (!text) return { done: false };

    const wrote = await sb(`items?id=eq.${id}`, {
      method: "PATCH",
      body: JSON.stringify({ transcript: text }),
    });
    if (!wrote.ok) return { done: false }; // likely migration 0005 not applied yet
    return { done: true };
  } catch {
    return { done: false };
  }
}
