import { useColorScheme } from "react-native";

export type ThemeColors = {
  bg: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  text: string;
  dim: string;
  accent: string;
  accentSoft: string;
  danger: string;
  /** Filled-pill background (Save button, selected filter chip). */
  pillBg: string;
  /** Text/icon color used on top of pillBg. */
  onAccent: string;
};

export const theme: { light: ThemeColors; dark: ThemeColors } = {
  light: {
    bg: "#F3F1EC",
    surface: "#FFFFFF",
    surfaceAlt: "#EAE7E0",
    border: "rgba(0,0,0,0.07)",
    text: "#1A1A1E",
    dim: "#70707A",
    accent: "#5B54E8",
    accentSoft: "rgba(91,84,232,0.12)",
    danger: "#D64545",
    pillBg: "#17171A",
    onAccent: "#FFFFFF",
  },
  dark: {
    bg: "#0A0A0C",
    surface: "#17171B",
    surfaceAlt: "#232329",
    border: "rgba(255,255,255,0.06)",
    text: "#F5F5F7",
    dim: "#94949C",
    accent: "#7C6CF7",
    accentSoft: "rgba(124,108,247,0.16)",
    danger: "#FF5A5A",
    pillBg: "#FFFFFF",
    onAccent: "#0A0A0C",
  },
};

export function useTheme(): ThemeColors {
  const scheme = useColorScheme();
  return scheme === "dark" ? theme.dark : theme.light;
}

/**
 * Colored tile shown in place of a thumbnail (no enrichment yet): one entry
 * per detected platform, keyed like store.ts PLATFORM_MAP values.
 */
export const PLATFORM_TILE: Record<string, { bg: string; glyph: string }> = {
  x: { bg: "#26262C", glyph: "X" },
  twitter: { bg: "#26262C", glyph: "X" },
  youtube: { bg: "#A32C2C", glyph: "▶" },
  instagram: { bg: "#A83A6E", glyph: "IG" },
  facebook: { bg: "#3A5A8C", glyph: "F" },
  reddit: { bg: "#B4532A", glyph: "R" },
  tiktok: { bg: "#2E5E5E", glyph: "T" },
  threads: { bg: "#4A4A52", glyph: "@" },
  pinterest: { bg: "#A34A3C", glyph: "P" },
  linkedin: { bg: "#2E5A8A", glyph: "in" },
  github: { bg: "#3A3A42", glyph: "G" },
  link: { bg: "#4C44C9", glyph: "L" },
  note: { bg: "#2E2E34", glyph: "”" },
};

export function platformTile(platform: string | null, kind: "link" | "text") {
  if (kind === "text") return PLATFORM_TILE.note;
  return PLATFORM_TILE[platform ?? ""] ?? PLATFORM_TILE.link;
}
