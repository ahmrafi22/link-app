// smoke test: IG reel → video_versions → mp4 download → ffmpeg → mp3
// (the Gemini ASR call runs on prod where the key lives)
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";

const url = process.argv[2];
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lv-smoke-"));
try {
  const page = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none", "Sec-Fetch-User": "?1",
      "Upgrade-Insecure-Requests": "1",
    },
    redirect: "follow",
  });
  console.log("page:", page.status);
  const html = (await page.text()).slice(0, 2_000_000);
  const m = /"video_versions":(\[.*?\])/.exec(html);
  if (!m) { console.log("no video_versions"); process.exit(1); }
  const versions = JSON.parse(m[1]);
  const videoUrl = versions.find((v) => typeof v?.url === "string")?.url;
  console.log("video url ok:", videoUrl?.slice(0, 60) + "…");

  const vid = await fetch(videoUrl, {
    headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.instagram.com/" },
    redirect: "follow",
  });
  const buf = await vid.arrayBuffer();
  console.log("mp4:", vid.status, Math.round(buf.byteLength / 1024) + "KB");

  const input = path.join(tmp, "reel.mp4");
  const output = path.join(tmp, "audio.mp3");
  await fs.writeFile(input, Buffer.from(buf));
  await new Promise((resolve, reject) =>
    execFile(ffmpegPath as string,
      ["-y", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", "-t", "900", output],
      { timeout: 60000 }, (e) => (e ? reject(e) : resolve(null)))
  );
  const mp3 = await fs.readFile(output);
  console.log("mp3:", Math.round(mp3.byteLength / 1024) + "KB", "— ready for ASR");
} finally {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
}
