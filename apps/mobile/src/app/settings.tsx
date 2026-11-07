import Constants from "expo-constants";
import { router } from "expo-router";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { clearApiConfig, getApiConfig, saveApiConfig, testConnection } from "@/lib/api";
import { loadItems, saveItems } from "@/lib/store";
import { syncVault } from "@/lib/sync";
import { useTheme, type ThemeColors } from "@/lib/theme";

export default function SettingsScreen() {
  const c = useTheme();
  const styles = useMemo(() => StyleSheet.create(createStyles(c)), [c]);

  const [apiBase, setApiBase] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [hadConfig, setHadConfig] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const config = await getApiConfig();
      if (config) {
        setApiBase(config.apiBase);
        setAppSecret(config.appSecret);
        setHadConfig(true);
      } else {
        setHadConfig(false);
      }
    })();
  }, []);

  const flashResult = useCallback((text: string) => {
    setResult(text);
    setTimeout(() => setResult(null), 4000);
  }, []);

  const onSave = useCallback(async () => {
    const base = apiBase.trim();
    const secret = appSecret.trim();
    if (!base || !secret) {
      flashResult("Both the URL and the secret are needed");
      return;
    }
    setBusy(true);
    try {
      await saveApiConfig({ apiBase: base, appSecret: secret });
      const health = await testConnection({ apiBase: base, appSecret: secret });
      if ("ok" in health && health.ok) {
        setHadConfig(true);
        flashResult(
          `Saved — server reachable · db: ${health.supabase}${
            health.auth === "missing" ? " · ⚠ server has no APP_SECRET set" : ""
          }`
        );
      } else {
        const err = health as { ok: false; error: string };
        setHadConfig(true);
        flashResult(`Saved, but test failed: ${err.error}`);
      }
    } finally {
      setBusy(false);
    }
  }, [apiBase, appSecret, flashResult]);

  const onDisconnect = useCallback(async () => {
    await clearApiConfig();
    setApiBase("");
    setAppSecret("");
    setHadConfig(false);
    flashResult("Disconnected — items stay on this phone");
  }, [flashResult]);

  const onSyncNow = useCallback(async () => {
    setBusy(true);
    try {
      const res = await syncVault(await loadItems());
      if ("skipped" in res && res.skipped) {
        flashResult("No server configured yet");
        return;
      }
      if (!("next" in res)) return;
      await saveItems(res.next);
      const parts: string[] = [];
      if (res.uploaded) parts.push(`↑${res.uploaded} uploaded`);
      if (res.pulled) parts.push(`↓${res.pulled} downloaded`);
      if (res.deleted) parts.push(`${res.deleted} deleted`);
      flashResult(parts.length > 0 ? parts.join(" · ") : "Everything already in sync");
    } finally {
      setBusy(false);
    }
  }, [flashResult]);

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right", "bottom"]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} accessibilityRole="button">
            <Text style={styles.back}>‹ Back</Text>
          </Pressable>
          <Text style={styles.title}>Settings</Text>
          <Text style={styles.version}>v{Constants.expoConfig?.version ?? "?"}</Text>
        </View>

        <ScrollView style={styles.flex} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <Text style={styles.sectionTitle}>Backend sync</Text>
          <Text style={styles.hint}>
            Paste your deployment URL and the APP_SECRET once. They are stored in
            the phone's secure keychain. Shares will upload automatically; until
            then everything stays on this device.
          </Text>

          <Text style={styles.label}>API base URL</Text>
          <TextInput
            style={styles.input}
            value={apiBase}
            onChangeText={setApiBase}
            placeholder="https://your-app.vercel.app"
            placeholderTextColor={c.dim}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />

          <Text style={styles.label}>APP_SECRET</Text>
          <TextInput
            style={[styles.input, styles.secret]}
            value={appSecret}
            onChangeText={setAppSecret}
            placeholder="the hex secret from your backend"
            placeholderTextColor={c.dim}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
          />

          {busy ? (
            <ActivityIndicator style={styles.spinner} color={c.accent} />
          ) : (
            <View style={styles.btnRow}>
              <Pressable style={[styles.btn, styles.primaryBtn]} onPress={() => void onSave()}>
                <Text style={styles.primaryBtnText}>Save + test</Text>
              </Pressable>
              <Pressable style={styles.btn} onPress={() => void onSyncNow()}>
                <Text style={styles.btnText}>Sync now</Text>
              </Pressable>
              {hadConfig && (
                <Pressable style={[styles.btn, styles.dangerBtn]} onPress={() => void onDisconnect()}>
                  <Text style={styles.dangerBtnText}>Disconnect</Text>
                </Pressable>
              )}
            </View>
          )}

          {result && <Text style={styles.result}>{result}</Text>}

          <Text style={styles.sectionTitle}>How sync works</Text>
          <Text style={styles.hint}>
            Everything is saved on this phone first — the app never blocks on the
            network. When a server is configured, new items upload in the
            background (retries are safe — the server dedupes), server items are
            pulled in, and deletes replay. Favorites stay on this device.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    flex: { flex: 1 },
    safe: { flex: 1, backgroundColor: c.bg },
    header: {
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 6,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
    },
    back: { color: c.accent, fontSize: 16, fontWeight: "700", paddingVertical: 4 },
    title: { fontSize: 22, fontWeight: "800", color: c.text, flex: 1 },
    version: { fontSize: 12, color: c.dim },
    body: { paddingHorizontal: 20, paddingBottom: 32, gap: 8 },
    sectionTitle: {
      fontSize: 17,
      fontWeight: "800",
      color: c.text,
      marginTop: 18,
      marginBottom: 2,
    },
    hint: { fontSize: 13.5, color: c.dim, lineHeight: 20 },
    label: { fontSize: 13, fontWeight: "700", color: c.text, marginTop: 8 },
    input: {
      backgroundColor: c.surface,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: Platform.OS === "ios" ? 12 : 10,
      fontSize: 15,
      color: c.text,
    },
    secret: { fontSize: 12.5 },
    btnRow: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 14 },
    btn: {
      backgroundColor: c.surface,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 12,
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    btnText: { color: c.text, fontWeight: "700", fontSize: 14 },
    primaryBtn: { backgroundColor: c.accent, borderColor: c.accent },
    primaryBtnText: { color: c.onAccent, fontWeight: "800", fontSize: 14 },
    dangerBtn: { borderColor: c.danger },
    dangerBtnText: { color: c.danger, fontWeight: "700", fontSize: 14 },
    spinner: { marginTop: 16 },
    result: {
      marginTop: 10,
      fontSize: 13.5,
      color: c.text,
      backgroundColor: c.surface,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 10,
      paddingVertical: 8,
      paddingHorizontal: 12,
      overflow: "hidden",
    },
  });
}
