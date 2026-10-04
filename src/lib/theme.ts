import { useColorScheme } from "react-native";

export type ThemeColors = {
  bg: string;
  surface: string;
  border: string;
  text: string;
  dim: string;
  accent: string;
  accentSoft: string;
  danger: string;
};

export const theme: { light: ThemeColors; dark: ThemeColors } = {
  light: {
    bg: "#F4F4FB",
    surface: "#FFFFFF",
    border: "#E4E3F2",
    text: "#1B1834",
    dim: "#6B6795",
    accent: "#4F46E5",
    accentSoft: "#E0E7FF",
    danger: "#DC2626",
  },
  dark: {
    bg: "#0F0E1D",
    surface: "#1B1834",
    border: "#2A2650",
    text: "#EDEBFF",
    dim: "#9B96C8",
    accent: "#818CF8",
    accentSoft: "#27234A",
    danger: "#F87171",
  },
};

export function useTheme(): ThemeColors {
  const scheme = useColorScheme();
  return scheme === "dark" ? theme.dark : theme.light;
}
