import { router } from "expo-router";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { clearExtractCache, extractForUrl } from "@/lib/extract";
import { domainOf, useVault, type VaultItem } from "@/lib/store";
import { useTheme, type ThemeColors } from "@/lib/theme";

/**
 * Hidden diagnostics for on-device extraction: long-press the "Vault" title.
 * Shows a network probe (does a known-good fetch work from inside the app?)
 * and a per-link report so "thumbnails not showing" can be pinned to a cause:
 * fetches failing on-device, sites refusing (url_only), or images existing
 * but failing to render.
 */

type RowState = { text: string; kind: "idle" | "busy" | "ok" | "warn" | "bad" };

export default function DiagnosticsScreen() {
  const c = useTheme();
  const styles = useMemo(() => createStyles(c), [c]);
  const { items, updateMany } = useVault();

  const [probe, setProbe] = useState<RowState>({ text: "testing…", kind: "busy" });
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [running, setRunning] = useState(false);

  const links = useMemo(
    () => items.filter((i) => i.kind === "link" && i.url).slice(0, 30),
    [items]
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const t0 = Date.now();
      try {
        const res = await fetch(
          "https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&format=json"
        );
        const body = await res.text();
        if (cancelled) return;
        setProbe({
          text: `probe fetch: HTTP ${res.status} · ${(body.length / 1024).toFixed(1)}KB · ${
            Date.now() - t0
          }ms`,
          kind: res.ok ? "ok" : "warn",
        });
      } catch (e: any) {
        if (cancelled) return;
        setProbe({
          text: `probe fetch FAILED: ${e?.message ?? "error"} · ${Date.now() - t0}ms`,
          kind: "bad",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const patchFromOutcome = useCallback(
    (item: VaultItem, outcome: Awaited<ReturnType<typeof extractForUrl>>) => {
      if (outcome.status !== "done") return;
      updateMany([
        {
          id: item.id,
          patch: {
            title: item.title ?? outcome.result.title,
            description: outcome.result.description,
            thumbnailUrl: outcome.result.thumbnailUrl,
            siteName: outcome.result.siteName,
            meta: outcome.result.meta,
            enrichmentLevel: outcome.result.level,
            enrichedAt: new Date().toISOString(),
            enrichAttempts: 0,
          },
        },
      ]);
    },
    [updateMany]
  );

  const rerunAll = useCallback(async () => {
    if (running) return;
    setRunning(true);
    await clearExtractCache();
    for (const item of links) {
      setRows((r) => ({ ...r, [item.id]: { text: "fetching…", kind: "busy" } }));
      const t0 = Date.now();
      const outcome = await extractForUrl(item.url!, { force: true });
      const ms = Date.now() - t0;
      patchFromOutcome(item, outcome);
      const text =
        outcome.status === "done"
          ? `${outcome.result.level} · thumb ${outcome.result.thumbnailUrl ? "YES" : "none"} · ${ms}ms`
          : outcome.status === "timeout"
            ? `TIMEOUT · ${ms}ms`
            : `NETWORK FAIL · ${ms}ms`;
      setRows((r) => ({
        ...r,
        [item.id]: {
          text,
          kind:
            outcome.status === "done" && outcome.result.thumbnailUrl
              ? "ok"
              : outcome.status === "done" && outcome.result.level !== "url_only"
                ? "ok"
                : "warn",
        },
      }));
    }
    setRunning(false);
  }, [links, patchFromOutcome, running]);

  const clearCache = useCallback(async () => {
    await clearExtractCache();
    setRows((r) => {
      const next: Record<string, RowState> = {};
      for (const k of Object.keys(r)) next[k] = { text: "cache cleared — not re-fetched yet", kind: "idle" };
      return next;
    });
  }, []);

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.topBar}>
          <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button">
            <Text style={styles.back}>‹</Text>
          </Pressable>
          <Text style={styles.title}>Diagnostics</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Network probe (from inside the app)</Text>
          <Text style={[styles.line, styles[probe.kind]]}>{probe.text}</Text>
        </View>

        <View style={styles.buttonRow}>
          <Pressable
            style={[styles.primaryBtn, running && { opacity: 0.5 }]}
            onPress={() => void rerunAll()}
            disabled={running}
          >
            <Text style={styles.primaryBtnText}>
              {running ? "Running…" : "Re-run all (ignores cache)"}
            </Text>
          </Pressable>
        </View>
        <View style={styles.buttonRow}>
          <Pressable style={styles.secondaryBtn2} onPress={() => void clearCache()}>
            <Text style={styles.secondaryBtnText}>Clear extraction cache</Text>
          </Pressable>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Links ({links.length})</Text>
          {links.length === 0 && <Text style={styles.line}>No links saved yet.</Text>}
          {links.map((item) => {
            const row = rows[item.id];
            const current =
              row?.text ??
              `${item.enrichmentLevel ?? "not fetched"} · thumb ${
                item.thumbnailUrl ? "YES" : "none"
              }${item.enrichAttempts ? ` · ${item.enrichAttempts} timeouts` : ""}`;
            const kind = row?.kind ?? (item.thumbnailUrl ? "ok" : item.enrichmentLevel === "url_only" ? "warn" : "idle");
            return (
              <View key={item.id} style={styles.row}>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {domainOf(item) ?? item.title}
                </Text>
                <Text style={[styles.line, styles[kind]]}>{current}</Text>
              </View>
            );
          })}
        </View>

        <Text style={styles.hint}>
          green = data captured · yellow = fetched but nothing usable (site blocked or
          login-walled) · red = network failure · "TIMEOUT" = no response in 7s
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.bg },
    content: { padding: 16, gap: 12, paddingBottom: 40 },
    topBar: { flexDirection: "row", alignItems: "center", gap: 8 },
    back: { fontSize: 34, color: c.text, lineHeight: 38 },
    title: { fontSize: 20, fontWeight: "800", color: c.text },
    card: { backgroundColor: c.surface, borderRadius: 16, padding: 14, gap: 8 },
    cardTitle: { fontSize: 13, fontWeight: "700", color: c.dim, textTransform: "uppercase" },
    row: { gap: 2, paddingTop: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
    rowTitle: { fontSize: 14, fontWeight: "600", color: c.text },
    line: { fontSize: 12.5, color: c.dim },
    idle: { color: c.dim },
    busy: { color: c.accent },
    ok: { color: "#63D68F" },
    warn: { color: "#E5B25D" },
    bad: { color: "#E5484D" },
    buttonRow: { flexDirection: "row", gap: 10 },
    primaryBtn: {
      flex: 1,
      backgroundColor: c.accent,
      borderRadius: 14,
      paddingVertical: 13,
      alignItems: "center",
    },
    primaryBtnText: { color: "#FFFFFF", fontWeight: "700", fontSize: 15 },
    secondaryBtn2: {
      flex: 1,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 14,
      paddingVertical: 11,
      alignItems: "center",
    },
    secondaryBtnText: { color: c.text, fontWeight: "600", fontSize: 14 },
    hint: { fontSize: 12, color: c.dim, lineHeight: 18 },
  });
}
