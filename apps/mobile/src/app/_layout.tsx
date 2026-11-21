import { Stack, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { StyleSheet, Text, View, useColorScheme } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";

import { theme } from "@/lib/theme";

// Do NOT call SplashScreen.preventAutoHideAsync() here: expo-router hides the
// splash itself once the root navigation is ready, but an explicit prevent
// without a matching hideAsync() keeps the splash up forever.

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
      <GestureHandlerRootView style={styles.root}>
        <StatusBar style={colorScheme === "dark" ? "light" : "dark"} />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: c.bg },
            // smooth curved screen transitions instead of hard cuts
            animation: "fade_from_bottom",
            animationDuration: 260,
          }}
        />
      </GestureHandlerRootView>
    </ThemeProvider>
  );
}

// Rendered instead of the app when any screen throws, so a crash is visible
// as text rather than a frozen splash screen.
export function ErrorBoundary({ error }: { error: Error }) {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Something went wrong</Text>
      <Text style={styles.message}>{error.message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.light.bg },
  container: {
    flex: 1,
    backgroundColor: theme.light.bg,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 12,
  },
  title: { fontSize: 18, fontWeight: "700", color: theme.light.text },
  message: { fontSize: 13, color: theme.light.dim, textAlign: "center" },
});
