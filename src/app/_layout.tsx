import { Stack, ThemeProvider } from "expo-router";
import { ShareIntentProvider } from "expo-share-intent";
import * as SplashScreen from "expo-splash-screen";
import { useColorScheme } from "react-native";

import { theme } from "@/lib/theme";

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const c = colorScheme === "dark" ? theme.dark : theme.light;
  return (
    <ThemeProvider
      value={{
        dark: colorScheme === "dark",
        colors: {
          primary: c.accent,
          background: c.bg,
          card: c.surface,
          text: c.text,
          border: c.border,
          notification: c.accent,
        },
        fonts: {
          regular: { fontFamily: "System", fontWeight: "400" },
          medium: { fontFamily: "System", fontWeight: "500" },
          bold: { fontFamily: "System", fontWeight: "700" },
          heavy: { fontFamily: "System", fontWeight: "900" },
        },
      }}
    >
      <ShareIntentProvider>
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: c.bg } }} />
      </ShareIntentProvider>
    </ThemeProvider>
  );
}
