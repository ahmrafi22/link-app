// Generates the Link Vault icon set from an inline SVG.
// Usage: npm run icons  (requires the sharp devDependency)
import sharp from "sharp";

// Feather "link" glyph (MIT): https://feathericons.com/icon/link
const LINK_PATHS = [
  "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71",
  "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
];

function glyph(size, stroke, color = "#FFFFFF") {
  // glyph is drawn in a 24x24 box, scaled up to `size` px
  const scale = size / 24;
  const paths = LINK_PATHS.map(
    (d) =>
      `<path d="${d}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>`
  ).join("");
  return `<g transform="scale(${scale})">${paths}</g>`;
}

const APP_ICON = 1024;
const appIconSvg = `<svg width="${APP_ICON}" height="${APP_ICON}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#4F46E5"/>
      <stop offset="1" stop-color="#312E81"/>
    </linearGradient>
  </defs>
  <rect width="${APP_ICON}" height="${APP_ICON}" fill="url(#bg)"/>
  <g transform="translate(${(APP_ICON - 528) / 2}, ${(APP_ICON - 528) / 2})">
    ${glyph(528, 2.1)}
  </g>
</svg>`;

// Android adaptive foreground: 1024 canvas, glyph well inside the 66% safe zone
const ADAPTIVE = 1024;
const adaptiveSvg = `<svg width="${ADAPTIVE}" height="${ADAPTIVE}" xmlns="http://www.w3.org/2000/svg">
  <g transform="translate(${(ADAPTIVE - 440) / 2}, ${(ADAPTIVE - 440) / 2})">
    ${glyph(440, 2.1)}
  </g>
</svg>`;

const SPLASH = 512;
const splashSvg = `<svg width="${SPLASH}" height="${SPLASH}" xmlns="http://www.w3.org/2000/svg">
  <g transform="translate(${(SPLASH - 264) / 2}, ${(SPLASH - 264) / 2})">
    ${glyph(264, 2.1)}
  </g>
</svg>`;

const out = "assets/images";
await sharp(Buffer.from(appIconSvg)).png().toFile(`${out}/icon.png`);
await sharp(Buffer.from(appIconSvg)).resize(48).png().toFile(`${out}/favicon.png`);
await sharp(Buffer.from(adaptiveSvg)).png().toFile(`${out}/android-icon-foreground.png`);
await sharp(Buffer.from(adaptiveSvg)).png().toFile(`${out}/android-icon-monochrome.png`);
await sharp(Buffer.from(splashSvg)).png().toFile(`${out}/splash-icon.png`);
console.log("icons generated in", out);
