// smoke test: run the transcript fetchers against real URLs
// usage: npx tsx scripts/transcript-smoke.ts <tiktokUrl|facebookUrl> ...
import { tiktokTranscript, facebookTranscript } from "../lib/transcripts";

const urls = process.argv.slice(2);
if (!urls.length) {
  console.log("pass one or more URLs");
  process.exit(1);
}
for (const url of urls) {
  const kind = /tiktok\.com/.test(url) ? tiktokTranscript : facebookTranscript;
  const t0 = Date.now();
  const text = await kind(url);
  console.log(`\n=== ${url} (${Date.now() - t0}ms) ===`);
  console.log(text ? `${text.slice(0, 220)}${text.length > 220 ? "…" : ""}` : "null");
}
