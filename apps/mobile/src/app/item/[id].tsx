import * as Clipboard from "expo-clipboard";
import * as WebBrowser from "expo-web-browser";
import { router, useLocalSearchParams } from "expo-router";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Image,
  ImageStyle,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import {
  createCategory,
  getApiConfig,
  listCategories,
  relatedCaptures,
  retryCapture,
  setItemCategory,
  type CategoryInfo,
} from "@/lib/api";
import { extractForUrl } from "@/lib/extract";
import { mergeServerIntoLocal, noteItemDeleted } from "@/lib/sync";
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

/** One-line reason under the chips, so "no thumbnail" always has a why. */
function levelHint(item: VaultItem): string | null {
  if (item.kind !== "link") return null;
  if (item.serverStatus === "failed")
    return "The server couldn't read this page either — re-try it below.";
  if (!item.enrichmentLevel) return "Not fetched yet — runs automatically when the app opens.";
  if (item.enrichmentLevel === "url_only")
    return "This site shared nothing with us — it's login-walled or blocking non-browser visitors.";
  if (!item.thumbnailUrl)
    return "This page shared text only — no image without logging in.";
  return null;
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
  const [retrying, setRetrying] = useState(false);
  const [heroRatio, setHeroRatio] = useState<number | null>(null);
  const [related, setRelated] = useState<
    Array<{ id: string; title: string | null; platform: string | null }> | null
  >(null);
  const [catPicker, setCatPicker] = useState(false);
  const [cats, setCats] = useState<CategoryInfo[]>([]);
  const [newCat, setNewCat] = useState("");
  const [catBusy, setCatBusy] = useState(false);

  const thumbnailUrl = item?.thumbnailUrl ?? null;
  useEffect(() => {
    setHeroRatio(null);
    if (!thumbnailUrl) return;
    let alive = true;
    Image.getSize(
      thumbnailUrl,
      (w, h) => {
        if (alive && w > 0 && h > 0) setHeroRatio(w / h);
      },
      () => {}
    );
    return () => {
      alive = false;
    };
  }, [thumbnailUrl]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 2400);
    return () => clearTimeout(t);
  }, [notice]);

  // related items — server vector neighbors, only navigable ones shown
  useEffect(() => {
    let alive = true;
    setRelated(null);
    void (async () => {
      if (!item?.serverId) return;
      const config = await getApiConfig();
      if (!config) return;
      const r = await relatedCaptures(config, item.serverId);
      if (alive && r.ok && r.items.length > 0) setRelated(r.items);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.serverId]);

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
    void noteItemDeleted(item);
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

  // forced re-enrichment on the SERVER — only surfaced on server-failed items
  const retryServer = useCallback(async () => {
    if (!item?.serverId || retrying) return;
    setRetrying(true);
    try {
      const config = await getApiConfig();
      if (!config) {
        setNotice("Connect a server in Settings first");
        return;
      }
      const r = await retryCapture(config, item.serverId);
      if (!r.ok) {
        setNotice(`Server retry failed: ${r.error}`);
        return;
      }
      updateMany([{ id: item.id, patch: { ...mergeServerIntoLocal(item, r.item) } }]);
      setNotice(
        r.item.status === "ready"
          ? "Server fetched the page"
          : "Server still can't read this page — try again later"
      );
    } finally {
      setRetrying(false);
    }
  }, [item, retrying, updateMany]);

  const openPicker = useCallback(async () => {
    const config = await getApiConfig();
    if (!config) {
      setNotice("Connect a server in Settings first");
      return;
    }
    setCatBusy(true);
    const r = await listCategories(config);
    setCatBusy(false);
    if (!r.ok) {
      setNotice(`Couldn't load categories: ${r.error}`);
      return;
    }
    setCats(r.categories);
    setNewCat("");
    setCatPicker(true);
  }, []);

  const applyCategory = useCallback(
    async (categoryId: string | null, categoryName: string | null) => {
      if (!item?.serverId) return;
      const config = await getApiConfig();
      if (!config) {
        setNotice("Connect a server in Settings first");
        return;
      }
      setCatBusy(true);
      const r = await setItemCategory(config, item.serverId, categoryId);
      setCatBusy(false);
      if (!r.ok) {
        setNotice(`Failed: ${r.error}`);
        return;
      }
      updateMany([
        { id: item.id, patch: { categoryId, categoryName: r.category_name } },
      ]);
      setCatPicker(false);
      setNotice(r.category_name ? `Filed under “${r.category_name}”` : "Removed from category");
    },
    [item, updateMany]
  );

  const createAndApply = useCallback(async () => {
    const name = newCat.trim();
    if (!name || catBusy || !item?.serverId) return;
    setCatBusy(true);
    const config = await getApiConfig();
    if (!config) {
      setCatBusy(false);
      return;
    }
    const cr = await createCategory(config, name);
    if (!cr.ok) {
      setCatBusy(false);
      setNotice(`Failed: ${cr.error}`);
      return;
    }
    const r = await setItemCategory(config, item.serverId, cr.category.id);
    setCatBusy(false);
    if (!r.ok) {
      setNotice(`Failed: ${r.error}`);
      return;
    }
    updateMany([{ id: item.id, patch: { categoryId: cr.category.id, categoryName: name } }]);
    setCatPicker(false);
    setNotice(`Filed under “${name}”`);
  }, [newCat, catBusy, item, updateMany]);

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
  const serverFailed = item.serverStatus === "failed";
  // local re-fetch is only offered where it can plausibly help — never on
  // healthy items (the server retry card covers failed ones)
  const localWeak =
    item.kind === "link" && (!item.enrichmentLevel || item.enrichmentLevel === "url_only");
  const metaRows: Array<[string, string]> = [];
  if (item.kind === "link") {
    // diagnostics: shows whether data was fetched, and how many attempts it took
    metaRows.push([
      "Page data",
      `${levelLabel(item)}${
        item.enrichAttempts > 0 ? ` · ${item.enrichAttempts} attempts` : ""
      }`,
    ]);
  }
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
          <View style={[styles.hero, heroRatio != null && { aspectRatio: Math.min(Math.max(heroRatio, 0.6), 3) }]}>
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
          {item.categoryName && (
            <View style={[styles.chip, styles.categoryChip]}>
              <Text style={[styles.chipText, styles.categoryChipText]}>
                🏷 {item.categoryName}
              </Text>
            </View>
          )}
        </View>

        {levelHint(item) ? <Text style={styles.levelHint}>{levelHint(item)}</Text> : null}

        {serverFailed && (
          <View style={styles.retryCard}>
            <Text style={styles.retryTitle}>Server fetch failed</Text>
            <Text style={styles.retryHint}>
              Your backend couldn't read this page yet — no title, description or
              thumbnail came back. One tap re-tries it from the server.
            </Text>
            <Pressable
              style={({ pressed }) => [styles.retryBtn, pressed && { opacity: 0.85 }]}
              onPress={() => void retryServer()}
              disabled={retrying}
              accessibilityRole="button"
              accessibilityLabel="Retry server fetch"
            >
              <Text style={styles.retryBtnText}>
                {retrying ? "Retrying…" : "↻ Retry server fetch"}
              </Text>
            </Pressable>
          </View>
        )}

        {item.description ? (
          <Text style={styles.description}>{item.description}</Text>
        ) : null}

        {item.summary ? (
          <View style={styles.summaryCard}>
            <Text style={styles.summaryLabel}>✦ AI summary</Text>
            <Text style={styles.summaryText}>{item.summary}</Text>
          </View>
        ) : null}

        {item.imageContext ? (
          <View style={styles.summaryCard}>
            <Text style={styles.summaryLabel}>🖼 In the image</Text>
            <Text style={styles.summaryText}>{item.imageContext}</Text>
          </View>
        ) : null}

        {item.topics && item.topics.length > 0 ? (
          <View style={styles.chipRow}>
            {item.topics.map((t) => (
              <View key={t} style={[styles.chip, styles.topicChip]}>
                <Text style={[styles.chipText, styles.topicChipText]}>#{t}</Text>
              </View>
            ))}
          </View>
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
          {item.url && !serverFailed && localWeak && (
            <Pressable
              style={styles.secondaryBtn}
              onPress={() => void refresh()}
              accessibilityLabel="Re-fetch page data"
            >
              <Text style={styles.secondaryBtnText}>{refreshing ? "…" : "↻"}</Text>
            </Pressable>
          )}
          {item.serverId && (
            <Pressable
              style={styles.secondaryBtn}
              onPress={() => void openPicker()}
              accessibilityLabel="Change category"
            >
              <Text style={styles.secondaryBtnText}>🏷</Text>
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

        {(() => {
          const relatedNav = (related ?? [])
            .map((r) => ({ ...r, localId: items.find((i) => i.serverId === r.id)?.id ?? null }))
            .filter((r) => r.localId !== null)
            .slice(0, 6);
          if (relatedNav.length === 0) return null;
          return (
            <View style={styles.relatedWrap}>
              <Text style={styles.relatedTitle}>Related</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <View style={{ flexDirection: "row", gap: 10 }}>
                  {relatedNav.map((r) => (
                    <Pressable
                      key={r.id}
                      style={styles.relatedCard}
                      onPress={() => r.localId && router.push(`/item/${r.localId}`)}
                      accessibilityRole="button"
                      accessibilityLabel={r.title ?? "Related item"}
                    >
                      <Text style={styles.relatedPlatform}>{r.platform ?? "•"}</Text>
                      <Text style={styles.relatedTitleText} numberOfLines={2}>
                        {r.title ?? "Untitled"}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </ScrollView>
            </View>
          );
        })()}

        <View style={styles.metaCard}>
          <View style={styles.rawHeader}>
            <Text style={styles.rawTitle}>All captured data (alpha)</Text>
            <Text style={styles.rawHint}>every field currently held for this item</Text>
          </View>
          {flattenItem(item).map(([key, value], i) => (
            <View
              key={`${key}-${i}`}
              style={styles.rawRow}
            >
              <Text style={styles.rawKey}>{key}</Text>
              <Text style={styles.rawValue}>{value}</Text>
            </View>
          ))}
        </View>

        {notice ? (
          <View style={styles.snackbar} pointerEvents="none">
            <Text style={styles.snackbarText}>{notice}</Text>
          </View>
        ) : null}

        <Modal
          visible={catPicker}
          transparent
          animationType="slide"
          onRequestClose={() => setCatPicker(false)}
        >
          <Pressable style={styles.sheetBackdrop} onPress={() => setCatPicker(false)}>
            <Pressable style={styles.sheet} onPress={() => {}}>
              <Text style={styles.sheetTitle}>Choose category</Text>
              <ScrollView style={styles.sheetList}>
                {cats.map((cat) => (
                  <Pressable
                    key={cat.id}
                    style={[
                      styles.sheetRow,
                      item.categoryId === cat.id && styles.sheetRowActive,
                    ]}
                    onPress={() => void applyCategory(cat.id, cat.name)}
                    accessibilityRole="button"
                  >
                    <Text style={styles.sheetRowName} numberOfLines={1}>
                      {cat.name}
                    </Text>
                    <Text style={styles.sheetRowCount}>{cat.count}</Text>
                  </Pressable>
                ))}
                <Pressable
                  style={styles.sheetRow}
                  onPress={() => void applyCategory(null, null)}
                  accessibilityRole="button"
                >
                  <Text style={[styles.sheetRowName, { color: c.dim }]}>Uncategorized</Text>
                </Pressable>
              </ScrollView>
              <View style={styles.sheetNewRow}>
                <TextInput
                  style={styles.sheetInput}
                  value={newCat}
                  onChangeText={setNewCat}
                  placeholder="New category…"
                  placeholderTextColor={c.dim}
                  autoCapitalize="words"
                  onSubmitEditing={() => void createAndApply()}
                />
                <Pressable
                  style={styles.sheetCreateBtn}
                  onPress={() => void createAndApply()}
                  accessibilityRole="button"
                >
                  <Text style={styles.sheetCreateText}>{catBusy ? "…" : "Add"}</Text>
                </Pressable>
              </View>
            </Pressable>
          </Pressable>
        </Modal>
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

/** Every field on the item, flat — the alpha "see inside" view. */
function flattenItem(item: VaultItem): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(item)) {
    if (value !== null && typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length === 0) {
        rows.push([key, "{}"]);
        continue;
      }
      for (const [k2, v2] of entries) rows.push([`${key}.${k2}`, String(v2)]);
    } else {
      rows.push([
        key,
        value === null || value === undefined || value === "" ? "—" : String(value),
      ]);
    }
  }
  return rows;
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
      borderRadius: 20,
      overflow: "hidden",
      alignItems: "center",
      justifyContent: "center",
      height: 190,
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
    categoryChip: { backgroundColor: c.accentSoft },
    categoryChipText: { color: c.accent },
    description: { fontSize: 15, color: c.dim, lineHeight: 22 },
    summaryCard: {
      backgroundColor: c.accentSoft,
      borderRadius: 16,
      padding: 14,
      gap: 4,
    },
    summaryLabel: { fontSize: 11.5, fontWeight: "800", color: c.accent, textTransform: "uppercase" },
    summaryText: { fontSize: 14.5, color: c.text, lineHeight: 21 },
    topicChip: { backgroundColor: c.surfaceAlt },
    topicChipText: { color: c.dim },
    relatedWrap: { gap: 8 },
    relatedTitle: { fontSize: 12, fontWeight: "700", color: c.dim, textTransform: "uppercase" },
    relatedCard: {
      width: 150,
      backgroundColor: c.surface,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.border,
      padding: 10,
      gap: 4,
    },
    relatedPlatform: { fontSize: 11, color: c.dim, fontWeight: "700" },
    relatedTitleText: { fontSize: 12.5, color: c.text, fontWeight: "600", lineHeight: 16 },
    sheetBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" },
    sheet: {
      backgroundColor: c.bg,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      paddingHorizontal: 16,
      paddingTop: 16,
      paddingBottom: 24,
      gap: 10,
    },
    sheetTitle: { fontSize: 16, fontWeight: "800", color: c.text },
    sheetList: { maxHeight: 280 },
    sheetRow: {
      flexDirection: "row",
      alignItems: "center",
      paddingVertical: 12,
      paddingHorizontal: 10,
      borderRadius: 10,
      gap: 10,
    },
    sheetRowActive: { backgroundColor: c.accentSoft },
    sheetRowName: { flex: 1, fontSize: 15, color: c.text, fontWeight: "600" },
    sheetRowCount: { fontSize: 12.5, color: c.dim },
    sheetNewRow: { flexDirection: "row", gap: 8 },
    sheetInput: {
      flex: 1,
      backgroundColor: c.surface,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 12,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 14,
      color: c.text,
    },
    sheetCreateBtn: {
      backgroundColor: c.accent,
      borderRadius: 12,
      paddingHorizontal: 18,
      alignItems: "center",
      justifyContent: "center",
    },
    sheetCreateText: { color: c.onAccent, fontWeight: "800", fontSize: 14 },
    levelHint: { fontSize: 12.5, color: c.dim, lineHeight: 17, marginTop: -6 },
    // shown only when the server pipeline marked the item failed
    retryCard: {
      backgroundColor: c.surface,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: c.border,
      padding: 14,
      gap: 8,
    },
    retryTitle: { fontSize: 14, fontWeight: "800", color: c.danger },
    retryHint: { fontSize: 12.5, color: c.dim, lineHeight: 18 },
    retryBtn: {
      alignSelf: "flex-start",
      backgroundColor: c.accent,
      borderRadius: 12,
      paddingHorizontal: 16,
      paddingVertical: 10,
      marginTop: 2,
    },
    retryBtnText: { color: c.onAccent, fontWeight: "700", fontSize: 14 },
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
    rawHeader: { paddingHorizontal: 14, paddingTop: 12, paddingBottom: 4, gap: 2 },
    rawTitle: { fontSize: 12, fontWeight: "700", color: c.dim, textTransform: "uppercase" },
    rawHint: { fontSize: 11.5, color: c.dim },
    rawRow: {
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
      flexDirection: "row",
      gap: 12,
      alignItems: "flex-start",
    },
    rawKey: { width: 110, fontSize: 11.5, color: c.dim, fontWeight: "600", paddingTop: 1 },
    rawValue: { flex: 1, fontSize: 12, color: c.text, lineHeight: 17 },
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
