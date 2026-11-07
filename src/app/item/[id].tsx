import * as Clipboard from "expo-clipboard";
import * as WebBrowser from "expo-web-browser";
import { router, useLocalSearchParams } from "expo-router";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Image,
  ImageStyle,
  Linking,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { extractForUrl } from "@/lib/extract";
import { domainOf, itemDisplayTitle, useVault, type VaultItem } from "@/lib/store";
import { platformTile, useTheme, type ThemeColors } from "@/lib/theme";

/** Human labels for the plan's enrichment_level values. */
function levelLabel(item: VaultItem): string {
  if (!item.enrichmentLevel) return "Not fetched yet";
  switch (item.enrichmentLevel) {
    case "full":
      return "Platform data";
    case "metadata":
      return "Page metadata";
    case "url_only":
      return "Link only";
  }
}

type DetailStyles = ReturnType<typeof createStyles>;

function levelChipStyle(
  level: VaultItem["enrichmentLevel"],
  styles: DetailStyles
): Record<string, unknown> {
  if (level === "full") return styles.levelFull;
  if (level === "metadata") return styles.levelMetadata;
  return {};
}

function levelChipTextStyle(
  level: VaultItem["enrichmentLevel"],
  styles: DetailStyles
): Record<string, unknown> {
  if (level === "full") return styles.levelFullText;
  if (level === "metadata") return styles.levelMetadataText;
  return {};
}

export default function ItemDetailScreen() {
  const c = useTheme();
  const styles = useMemo(() => createStyles(c), [c]);
  const { id } = useLocalSearchParams<{ id: string }>();

  const { items, loaded, remove, updateMany, toggleFavorite } = useVault();
  const item = items.find((i) => i.id === id);

  const [notice, setNotice] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 2400);
    return () => clearTimeout(t);
  }, [notice]);

  const openLink = useCallback(async (url: string) => {
    try {
      await WebBrowser.openBrowserAsync(url, { showTitle: true });
    } catch {
      Linking.openURL(url).catch(() => {});
    }
  }, []);

  const confirmDelete = useCallback(() => {
    if (!item) return;
    remove(item.id);
    router.back();
  }, [item, remove]);

  const refresh = useCallback(async () => {
    if (!item?.url || refreshing) return;
    setRefreshing(true);
    try {
      const outcome = await extractForUrl(item.url, { force: true });
      if (outcome.status === "done") {
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
        setNotice(
          outcome.result.level === "url_only"
            ? "Nothing more found — this page hides its data"
            : "Updated from the page"
        );
      } else {
        setNotice("Couldn't reach the page");
      }
    } finally {
      setRefreshing(false);
    }
  }, [item, refreshing, updateMany]);

  if (!loaded) {
    return (
      <SafeAreaView style={styles.safe}>
        <Text style={styles.dim}>Loading…</Text>
      </SafeAreaView>
    );
  }
  if (!item) {
    return (
      <SafeAreaView style={styles.safe}>
        <Header styles={styles} />
        <Text style={styles.dim}>This item no longer exists.</Text>
      </SafeAreaView>
    );
  }

  const domain = domainOf(item);
  const tile = platformTile(item.platform, item.kind);
  const metaRows: Array<[string, string]> = [];
  if (item.siteName) metaRows.push(["Source", item.siteName]);
  if (domain) metaRows.push(["Domain", domain]);
  if (item.meta) {
    for (const [k, v] of Object.entries(item.meta)) {
      metaRows.push([k.charAt(0).toUpperCase() + k.slice(1), String(v)]);
    }
  }
  metaRows.push(["Captured", new Date(item.createdAt).toLocaleString()]);
  if (item.seenCount > 1) {
    metaRows.push([
      "Shared again",
      `${item.seenCount} times · last ${new Date(item.lastSeenAt).toLocaleString()}`,
    ]);
  }

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.content} stickyHeaderIndices={[0]}>
        <View style={styles.topBar}>
          <Pressable
            onPress={() => router.back()}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Back"
          >
            <Text style={styles.back}>‹</Text>
          </Pressable>
          <View style={styles.topBarSpacer} />
          {item.kind === "link" && (
            <Pressable
              onPress={() => toggleFavorite(item.id)}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel={item.favorite ? "Unstar" : "Star"}
            >
              <Text style={[styles.star, item.favorite && styles.starActive]}>
                {item.favorite ? "★" : "☆"}
              </Text>
            </Pressable>
          )}
        </View>

        {item.thumbnailUrl ? (
          <View style={styles.hero}>
            <Image
              source={{ uri: item.thumbnailUrl }}
              style={styles.heroImage}
              resizeMode="cover"
            />
          </View>
        ) : (
          <View style={[styles.hero, styles.heroFallback, { backgroundColor: tile.bg }]}>
            <Text style={[styles.heroGlyph, tile.glyph.length > 1 && styles.heroGlyphSmall]}>
              {tile.glyph}
            </Text>
          </View>
        )}

        <Text style={styles.title}>{itemDisplayTitle(item)}</Text>

        <View style={styles.chipRow}>
          <View style={styles.chip}>
            <Text style={styles.chipText}>{item.platform ?? (item.kind === "text" ? "note" : "link")}</Text>
          </View>
          {item.kind === "link" && (
          <View style={[styles.chip, levelChipStyle(item.enrichmentLevel, styles)]}>
            <Text
              style={[styles.chipText, levelChipTextStyle(item.enrichmentLevel, styles)]}
            >
              {levelLabel(item)}
            </Text>
          </View>
          )}
        </View>

        {item.description ? (
          <Text style={styles.description}>{item.description}</Text>
        ) : null}

        {item.kind === "text" && item.rawText ? (
          <View style={styles.noteCard}>
            <Text style={styles.noteText}>{item.rawText}</Text>
          </View>
        ) : null}

        <View style={styles.buttonRow}>
          {item.url && (
            <Pressable style={styles.primaryBtn} onPress={() => void openLink(item.url!)}>
              <Text style={styles.primaryBtnText}>Open link</Text>
            </Pressable>
          )}
          {item.url && (
            <Pressable
              style={styles.secondaryBtn}
              onPress={() => void refresh()}
              accessibilityLabel="Re-fetch page data"
            >
              <Text style={styles.secondaryBtnText}>{refreshing ? "…" : "↻"}</Text>
            </Pressable>
          )}
          <Pressable
            style={styles.secondaryBtn}
            onPress={() => {
              const text = item.url ?? item.rawText ?? "";
              if (text) void Share.share({ message: text });
            }}
            accessibilityLabel="Share"
          >
            <Text style={styles.secondaryBtnText}>↗</Text>
          </Pressable>
          <Pressable
            style={styles.secondaryBtn}
            onPress={() => {
              const text = item.url ?? item.rawText ?? "";
              if (text) void Clipboard.setStringAsync(text);
              setNotice("Copied");
            }}
            accessibilityLabel="Copy"
          >
            <Text style={styles.secondaryBtnText}>⧉</Text>
          </Pressable>
          <Pressable
            style={styles.secondaryBtn}
            onPress={() =>
              Alert.alert("Delete item?", itemDisplayTitle(item), [
                { text: "Cancel", style: "cancel" },
                { text: "Delete", style: "destructive", onPress: confirmDelete },
              ])
            }
            accessibilityLabel="Delete"
          >
            <Text style={[styles.secondaryBtnText, { color: "#E5484D" }]}>✕</Text>
          </Pressable>
        </View>

        <View style={styles.metaCard}>
          {item.url ? (
            <MetaRow
              label="Link"
              value={item.url}
              onPress={() => void openLink(item.url!)}
              styles={styles}
            />
          ) : null}
          {metaRows.map(([label, value]) => (
            <MetaRow key={label} label={label} value={value} styles={styles} />
          ))}
        </View>

        {notice ? (
          <View style={styles.snackbar} pointerEvents="none">
            <Text style={styles.snackbarText}>{notice}</Text>
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function Header({ styles }: { styles: ReturnType<typeof createStyles> }) {
  return (
    <View style={styles.topBar}>
      <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button">
        <Text style={styles.back}>‹</Text>
      </Pressable>
      <View style={styles.topBarSpacer} />
    </View>
  );
}

function MetaRow({
  label,
  value,
  onPress,
  styles,
}: {
  label: string;
  value: string;
  onPress?: () => void;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <Pressable onPress={onPress} disabled={!onPress} style={styles.metaRow}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={[styles.metaValue, onPress && styles.metaLink]} numberOfLines={onPress ? 1 : undefined}>
        {value}
      </Text>
    </Pressable>
  );
}

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.bg },
    content: { padding: 16, gap: 14, paddingBottom: 40 },
    topBar: {
      flexDirection: "row",
      alignItems: "center",
      marginHorizontal: -8,
      backgroundColor: c.bg,
    },
    topBarSpacer: { flex: 1 },
    back: { fontSize: 34, color: c.text, lineHeight: 38, paddingHorizontal: 8 },
    star: { fontSize: 24, color: c.dim, paddingHorizontal: 8 },
    starActive: { color: "#F5B83D" },
    hero: {
      height: 190,
      borderRadius: 20,
      overflow: "hidden",
      alignItems: "center",
      justifyContent: "center",
    },
    heroImage: { width: "100%", height: "100%" } as ImageStyle,
    heroFallback: { height: 120 },
    heroGlyph: { fontSize: 56, fontWeight: "800", color: "#FFFFFF", opacity: 0.92 },
    heroGlyphSmall: { fontSize: 40 },
    title: { fontSize: 22, fontWeight: "800", color: c.text, lineHeight: 28, letterSpacing: -0.4 },
    chipRow: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
    chip: {
      backgroundColor: c.surfaceAlt,
      borderRadius: 999,
      paddingHorizontal: 12,
      paddingVertical: 5,
    },
    chipText: { fontSize: 12.5, fontWeight: "600", color: c.text },
    levelFull: { backgroundColor: "#1E3A2F" },
    levelFullText: { color: "#63D68F" },
    levelMetadata: { backgroundColor: "#1F2A3D" },
    levelMetadataText: { color: "#7EB3E8" },
    description: { fontSize: 15, color: c.dim, lineHeight: 22 },
    noteCard: { backgroundColor: c.surface, borderRadius: 16, padding: 14 },
    noteText: { fontSize: 15, color: c.text, lineHeight: 22 },
    buttonRow: { flexDirection: "row", gap: 10, marginTop: 2 },
    primaryBtn: {
      flex: 1,
      backgroundColor: c.accent,
      borderRadius: 14,
      paddingVertical: 13,
      alignItems: "center",
    },
    primaryBtnText: { color: "#FFFFFF", fontWeight: "700", fontSize: 15 },
    secondaryBtn: {
      width: 48,
      borderRadius: 14,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      alignItems: "center",
      justifyContent: "center",
    },
    secondaryBtnText: { fontSize: 18, color: c.text, fontWeight: "600" },
    metaCard: { backgroundColor: c.surface, borderRadius: 16, overflow: "hidden" },
    metaRow: {
      paddingHorizontal: 14,
      paddingVertical: 11,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
      flexDirection: "row",
      gap: 12,
    },
    metaLabel: { width: 92, fontSize: 13, color: c.dim, fontWeight: "600" },
    metaValue: { flex: 1, fontSize: 13.5, color: c.text, lineHeight: 19 },
    metaLink: { color: c.accent },
    snackbar: {
      position: "absolute",
      bottom: 24,
      alignSelf: "center",
      backgroundColor: c.text,
      borderRadius: 999,
      paddingHorizontal: 18,
      paddingVertical: 10,
      elevation: 4,
    },
    snackbarText: { color: c.bg, fontWeight: "600", fontSize: 13 },
    dim: { color: c.dim, padding: 24 },
  });
}
