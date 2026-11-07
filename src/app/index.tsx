import * as Clipboard from "expo-clipboard";
import * as WebBrowser from "expo-web-browser";
import { router } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  AppState,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { drainInbox, inboxEntryToShareInput } from "@/lib/inbox";
import { enrichLinks, selectEnrichTargets } from "@/lib/extract";
import { domainOf, itemDisplayTitle, useVault, type VaultItem } from "@/lib/store";
import { platformTile, useTheme, type ThemeColors } from "@/lib/theme";

export default function InboxScreen() {
  const c = useTheme();
  const styles = useMemo(() => createStyles(c), [c]);

  const { items, loaded, add, remove, updateMany, itemsRef } = useVault();

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<{ id: number; text: string } | null>(null);

  const flash = useCallback((text: string) => {
    setNotice({ id: Date.now(), text });
  }, []);

  // auto-hide the snackbar
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 2400);
    return () => clearTimeout(t);
  }, [notice]);

  // Drain the share inbox written by the native silent share target. Shares
  // land in a file while we're backgrounded; import them whenever the app
  // comes to the foreground. Gated on `loaded` so we never merge into an
  // empty list before AsyncStorage has restored the vault.
  const enrichingRef = useRef(false);
  const runEnrichment = useCallback(async () => {
    if (enrichingRef.current) return;
    const targets = selectEnrichTargets(itemsRef.current);
    if (targets.length === 0) return;
    enrichingRef.current = true;
    try {
      const updates = await enrichLinks(targets);
      updateMany(updates);
    } finally {
      enrichingRef.current = false;
    }
  }, [itemsRef, updateMany]);

  useEffect(() => {
    if (!loaded) return;
    const drain = async () => {
      const entries = await drainInbox();
      if (entries.length > 0) {
        let saved = 0;
        let duplicates = 0;
        for (const entry of entries) {
          const result = add(inboxEntryToShareInput(entry));
          if (!result) continue;
          if (result.duplicate) duplicates += 1;
          else saved += 1;
        }
        const parts: string[] = [];
        if (saved > 0) parts.push(`Saved ${saved} shared item${saved === 1 ? "" : "s"}`);
        if (duplicates > 0) parts.push(`${duplicates} already saved`);
        if (parts.length > 0) flash(parts.join(" · "));
      }
      void runEnrichment();
    };
    void drain();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void drain();
    });
    return () => sub.remove();
  }, [loaded, add, flash, runEnrichment]);

  // filter chips: everything actually present in the vault, first-seen order
  const filters = useMemo(() => {
    const platforms: string[] = [];
    let hasNote = false;
    for (const i of items) {
      if (i.kind === "text") {
        hasNote = true;
      } else {
        const p = i.platform ?? "link";
        if (!platforms.includes(p)) platforms.push(p);
      }
    }
    return ["all", ...platforms, ...(hasNote ? ["note"] : [])];
  }, [items]);

  // drop the active chip if its platform no longer exists
  useEffect(() => {
    if (filter !== "all" && !filters.includes(filter)) setFilter("all");
  }, [filters, filter]);

  const filtered = useMemo(() => {
    let list = items;
    if (filter === "note") list = list.filter((i) => i.kind === "text");
    else if (filter !== "all")
      list = list.filter(
        (i) => i.kind === "link" && (i.platform ?? "link") === filter
      );
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter((i) =>
        [i.title, i.url, i.rawText, i.description, i.siteName, i.platform]
          .filter(Boolean)
          .some((v) => (v as string).toLowerCase().includes(q))
      );
    }
    return list;
  }, [items, search, filter]);

  const openLink = useCallback(async (url: string) => {
    try {
      await WebBrowser.openBrowserAsync(url, { showTitle: true });
    } catch {
      Linking.openURL(url).catch(() => {});
    }
  }, []);

  const copyItem = useCallback(
    (item: VaultItem) => {
      const text = item.url ?? item.rawText ?? "";
      if (!text) return;
      void Clipboard.setStringAsync(text);
      flash("Copied");
    },
    [flash]
  );

  const confirmDelete = useCallback(
    (item: VaultItem) => {
      remove(item.id);
      flash("Deleted");
    },
    [remove, flash]
  );

  const showMenu = useCallback(
    (item: VaultItem) => {
      if (Platform.OS === "web") {
        copyItem(item);
        return;
      }
      const buttons: Array<{
        text: string;
        style?: "default" | "cancel" | "destructive";
        onPress?: () => void;
      }> = [{ text: "Copy", onPress: () => copyItem(item) }];
      if (item.url) {
        buttons.push({ text: "Open", onPress: () => void openLink(item.url!) });
      }
      buttons.push({
        text: "Delete",
        style: "destructive",
        onPress: () => confirmDelete(item),
      });
      buttons.push({ text: "Cancel", style: "cancel" });
      Alert.alert(itemDisplayTitle(item), item.url ?? undefined, buttons);
    },
    [copyItem, openLink, confirmDelete]
  );

  const saveDraft = useCallback(() => {
    const result = add({ text: draft });
    if (!result) {
      flash("Type or paste a link first");
      return;
    }
    setDraft("");
    flash(result.duplicate ? "Already in your vault" : "Saved to your vault");
  }, [add, draft, flash]);

  const linkCount = items.filter((i) => i.kind === "link").length;

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right", "bottom"]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.header}>
          <Text style={styles.title}>Vault</Text>
          <Text style={styles.subtitle}>
            {loaded
              ? `${items.length} saved${linkCount !== items.length ? ` · ${linkCount} links` : ""}`
              : "Loading…"}
          </Text>
        </View>

        {filters.length > 2 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.pillRow}
          >
            {filters.map((f) => {
              const active = filter === f;
              return (
                <Pressable
                  key={f}
                  onPress={() => setFilter(f)}
                  style={[styles.pill, active && styles.pillActive]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                >
                  <Text style={[styles.pillText, active && styles.pillTextActive]}>
                    {f === "all" ? "All" : f === "note" ? "Notes" : f}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        )}

        <View style={styles.searchRow}>
          <TextInput
            style={styles.input}
            value={search}
            onChangeText={setSearch}
            placeholder="Search your vault"
            placeholderTextColor={c.dim}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
          />
        </View>

        {loaded && items.length === 0 ? (
          <EmptyState styles={styles} />
        ) : (
          <FlatList
            data={filtered}
            keyExtractor={(i) => i.id}
            numColumns={2}
            columnWrapperStyle={styles.column}
            contentContainerStyle={styles.listContent}
            keyboardShouldPersistTaps="handled"
            ListEmptyComponent={
              <Text style={styles.noResults}>
                Nothing matches “{search.trim()}”.
              </Text>
            }
            renderItem={({ item }) => (
              <ItemCard
                item={item}
                styles={styles}
                onPress={() => router.push(`/item/${item.id}`)}
                onLongPress={() => showMenu(item)}
              />
            )}
          />
        )}

        <View style={styles.captureBar}>
          <TextInput
            style={[styles.input, styles.flex]}
            value={draft}
            onChangeText={setDraft}
            placeholder="Paste a link or some text…"
            placeholderTextColor={c.dim}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="done"
            onSubmitEditing={saveDraft}
          />
          <Pressable
            style={({ pressed }) => [styles.saveFab, pressed && { opacity: 0.7 }]}
            onPress={saveDraft}
            accessibilityLabel="Save pasted content"
          >
            <Text style={styles.saveFabText}>+</Text>
          </Pressable>
        </View>

        {notice && (
          <View style={styles.snackbar} pointerEvents="none">
            <Text style={styles.snackbarText}>{notice.text}</Text>
          </View>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function EmptyState({ styles }: { styles: ReturnType<typeof createStyles> }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>Your vault is empty</Text>
      <Text style={styles.emptyBody}>
        In any app — X, Instagram, YouTube, your browser — tap Share and choose{" "}
        <Text style={styles.emptyBold}>Link Vault</Text>. It saves the link with a quick
        toast and you stay right where you were. You can also paste one below.
      </Text>
    </View>
  );
}

function ItemCard({
  item,
  styles,
  onPress,
  onLongPress,
}: {
  item: VaultItem;
  styles: ReturnType<typeof createStyles>;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const domain = domainOf(item);
  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.8 }]}
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole={item.url ? "link" : "button"}
    >
      <CardTile item={item} styles={styles} />
      <View style={styles.cardBody}>
        <Text style={styles.cardTitle} numberOfLines={2}>
          {itemDisplayTitle(item)}
        </Text>
        {item.description ? (
          <Text style={styles.cardDetail} numberOfLines={2}>
            {item.description}
          </Text>
        ) : item.url ? (
          <Text style={styles.cardDetail} numberOfLines={1}>
            {domain ?? item.url}
          </Text>
        ) : item.rawText ? (
          <Text style={styles.cardDetail} numberOfLines={2}>
            {item.rawText}
          </Text>
        ) : null}
        <Text style={styles.cardWhen}>{formatWhen(item.lastSeenAt || item.createdAt)}</Text>
      </View>
    </Pressable>
  );
}

/** Tile with the captured thumbnail when we have one, colored glyph otherwise. */
function CardTile({
  item,
  styles,
}: {
  item: VaultItem;
  styles: ReturnType<typeof createStyles>;
}) {
  const [broken, setBroken] = useState(false);
  const tile = platformTile(item.platform, item.kind);
  const showImage = item.thumbnailUrl && !broken;
  return (
    <View style={[styles.tile, !showImage && { backgroundColor: tile.bg }]}>
      {showImage ? (
        <Image
          source={{ uri: item.thumbnailUrl! }}
          style={styles.tileImage}
          resizeMode="cover"
          onError={() => setBroken(true)}
        />
      ) : (
        <Text style={[styles.tileGlyph, tile.glyph.length > 1 && styles.tileGlyphSmall]}>
          {tile.glyph}
        </Text>
      )}
      {item.seenCount > 1 && (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>×{item.seenCount}</Text>
        </View>
      )}
    </View>
  );
}

function formatWhen(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const min = Math.floor((Date.now() - then) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return "yesterday";
  if (d < 7) return `${d}d ago`;
  return new Date(then).toLocaleDateString();
}

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    flex: { flex: 1 },
    safe: { flex: 1, backgroundColor: c.bg },
    header: {
      paddingHorizontal: 20,
      paddingTop: 12,
      paddingBottom: 10,
      gap: 2,
    },
    title: { fontSize: 32, fontWeight: "800", color: c.text, letterSpacing: -0.8 },
    subtitle: { fontSize: 13, color: c.dim },
    pillRow: { gap: 8, paddingHorizontal: 20, paddingBottom: 4 },
    pill: {
      backgroundColor: c.surfaceAlt,
      borderRadius: 999,
      paddingHorizontal: 15,
      paddingVertical: 8,
    },
    pillActive: { backgroundColor: c.pillBg },
    pillText: { fontSize: 13.5, fontWeight: "600", color: c.text },
    pillTextActive: { color: c.onAccent, fontWeight: "700" },
    searchRow: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 10 },
    input: {
      backgroundColor: c.surface,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 14,
      paddingHorizontal: 15,
      paddingVertical: Platform.OS === "ios" ? 12 : 10,
      fontSize: 15,
      color: c.text,
    },
    listContent: { gap: 12, paddingHorizontal: 20, paddingBottom: 24, paddingTop: 2 },
    column: { gap: 12 },
    card: {
      flex: 1,
      backgroundColor: c.surface,
      borderRadius: 20,
      overflow: "hidden",
    },
    tile: {
      height: 92,
      alignItems: "center",
      justifyContent: "center",
      overflow: "hidden",
    },
    tileImage: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
    tileGlyph: { fontSize: 32, fontWeight: "800", color: "#FFFFFF", opacity: 0.92 },
    tileGlyphSmall: { fontSize: 24 },
    badge: {
      position: "absolute",
      top: 8,
      right: 8,
      backgroundColor: "rgba(0,0,0,0.55)",
      borderRadius: 999,
      paddingHorizontal: 8,
      paddingVertical: 2,
    },
    badgeText: { color: "#FFFFFF", fontSize: 11, fontWeight: "700" },
    cardBody: { padding: 12, gap: 5 },
    cardTitle: { fontSize: 14.5, fontWeight: "600", color: c.text, lineHeight: 19 },
    cardDetail: { fontSize: 12, color: c.dim },
    cardWhen: { fontSize: 11, color: c.dim, marginTop: 2 },
    captureBar: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingHorizontal: 16,
      paddingTop: 10,
      paddingBottom: 12,
      backgroundColor: c.bg,
      borderTopWidth: 1,
      borderTopColor: c.border,
    },
    saveFab: {
      width: 46,
      height: 46,
      borderRadius: 999,
      backgroundColor: c.pillBg,
      alignItems: "center",
      justifyContent: "center",
    },
    saveFabText: { color: c.onAccent, fontSize: 24, fontWeight: "700", marginTop: -2 },
    empty: { flex: 1, padding: 32, justifyContent: "center", gap: 10 },
    emptyTitle: { fontSize: 20, fontWeight: "700", color: c.text, textAlign: "center" },
    emptyBody: { fontSize: 15, color: c.dim, textAlign: "center", lineHeight: 22 },
    emptyBold: { fontWeight: "700", color: c.text },
    noResults: { color: c.dim, textAlign: "center", marginTop: 24, fontSize: 14 },
    snackbar: {
      position: "absolute",
      bottom: 88,
      alignSelf: "center",
      backgroundColor: c.text,
      borderRadius: 999,
      paddingHorizontal: 18,
      paddingVertical: 10,
      shadowColor: "#000",
      shadowOpacity: 0.25,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 4 },
      elevation: 4,
    },
    snackbarText: { color: c.bg, fontWeight: "600", fontSize: 13 },
  });
}
