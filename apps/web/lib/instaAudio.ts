import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import ffmpegPath from "ffmpeg-static";

import { aiAudio } from "./ai";
import { cap } from "./normalize";
import { BROWSER_HEADERS } from "./transcripts";

/**
 * Phase ⑦ — Instagram reel audio → transcript.
 * Instagram exposes no caption files, but the reel's own mp4 is publicly
 * fetchable from the page (`video_versions[0].url`, verified 2026-11-21).
 * Pipeline: page → mp4 (≤40MB, 30s) → ffmpeg demux to 16kHz mono mp3
 * (~0.5MB per minute) → Gemini inline-audio transcription → plain text.
 *
 * The bytes pass through to the transcription model and are never stored;
 * only the text lands in items.transcript. Same rules as everywhere else:
 * public logged-out content, one attempt, silent null on any failure.
 */

const AUDIO_PROMPT =
  "Transcribe every spoken word in this audio verbatim, in the language spoken. " +
  "Plain text only — no timestamps, no speaker labels, no markdown. " +
  "If nothing is spoken, reply with exactly: NO_SPEECH";

const VIDEO_MAX_BYTES = 40 * 1024 * 1024;
const VIDEO_TIMEOUT = 30_000;
const AUDIO_MAX_SECONDS = 900; // 15 min ceiling — reels are minutes long

export async function instagramAudioTranscript(url: string): Promise<string | null> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lv-"));
  try {
    // 1) reel page → video_versions[0].url
    const page = await fetch(url, {
      headers: BROWSER_HEADERS,
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    if (!page.ok) return null;
    const html = (await page.text()).slice(0, 2_000_000);
    const arrMatch = /"video_versions":(\[.*?\])/.exec(html);
    if (!arrMatch) return null;
    let versions: Array<{ url?: string }>;
    try {
      versions = JSON.parse(arrMatch[1]);
    } catch {
      return null;
    }
    const videoUrl = versions.find((v) => typeof v?.url === "string" && v.url.startsWith("https://"))?.url;
    if (!videoUrl) return null;

    // 2) download the mp4
    const vid = await fetch(videoUrl, {
      headers: { "User-Agent": BROWSER_HEADERS["User-Agent"], Referer: "https://www.instagram.com/" },
      redirect: "follow",
      signal: AbortSignal.timeout(VIDEO_TIMEOUT),
    });
    if (!vid.ok) return null;
    const buf = await vid.arrayBuffer();
    if (buf.byteLength === 0 || buf.byteLength > VIDEO_MAX_BYTES) return null;

    // 3) ffmpeg → 16kHz mono mp3 (audio only — video bytes never leave the box)
    const input = path.join(tmp, "reel.mp4");
    const output = path.join(tmp, "audio.mp3");
    await fs.writeFile(input, Buffer.from(buf));
    const bin = ffmpegPath as string | null;
    if (!bin) return null;
    await new Promise<void>((resolve, reject) =>
      execFile(
        bin,
        ["-y", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", "-t", String(AUDIO_MAX_SECONDS), output],
        { timeout: 60_000 },
        (err) => (err ? reject(err) : resolve())
      )
    );
    const mp3 = await fs.readFile(output);
    if (mp3.byteLength < 1000) return null;

    // 4) transcribe
    const raw = await aiAudio(mp3.toString("base64"), "audio/mp3", AUDIO_PROMPT);
    if (!raw || raw.trim() === "NO_SPEECH") return null;
    return cap(raw.replace(/\s+/g, " ").trim(), 15_000);
  } catch {
    return null;
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
