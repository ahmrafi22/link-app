import * as Clipboard from "expo-clipboard";
import Constants from "expo-constants";
import * as WebBrowser from "expo-web-browser";
import { router, useFocusEffect } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  AppState,
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

import { createCardStyles, MasonryGrid } from "@/components/cards";
import { getApiConfig } from "@/lib/api";
import { DEMO_URLS, enrichLinks, selectEnrichTargets } from "@/lib/extract";
import { folderLabel, foldersFromItems, type Folder } from "@/lib/folders";
import { drainInbox, inboxEntryToShareInput } from "@/lib/inbox";
import { noteItemDeleted, syncVault } from "@/lib/sync";
import { itemDisplayTitle, useVault, type VaultItem } from "@/lib/store";
import { platformTile, useTheme, type ThemeColors } from "@/lib/theme";

export default function InboxScreen() {
  const c = useTheme();
  const styles = useMemo(
    () => StyleSheet.create({ ...createCardStyles(c), ...createStyles(c) }),
    [c]
  );

  const { items, loaded, add, remove, updateMany, toggleFavorite, applyAll, reload, itemsRef } =
    useVault();

  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<{ id: number; text: string } | null>(null);
  const [fetchingCount, setFetchingCount] = useState(0);
  const [syncOn, setSyncOn] = useState(false);

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
    setFetchingCount(targets.length);
    try {
      // apply each result the moment it lands — cards fill in progressively
      let enriched = 0;
      await enrichLinks(targets, (update) => {
        if (update.patch.enrichmentLevel) enriched += 1;
        updateMany([update]);
        setFetchingCount((n) => Math.max(0, n - 1));
      });
      if (enriched === 0) {
        flash("Page fetch failed on this network — hold “Vault” for Diagnostics");
      }
    } finally {
      enrichingRef.current = false;
      setFetchingCount(0);
    }
  }, [itemsRef, updateMany, flash]);

  // Background sync round (Phase ②): upload the outbox, pull server items,
  // replay deletes. Silent when nothing changed or no server is configured.
  const syncingRef = useRef(false);
  const runSync = useCallback(async () => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    try {
      const res = await syncVault(itemsRef.current);
      if ("skipped" in res) return;
      applyAll(res.next);
      const parts: string[] = [];
      if (res.uploaded > 0) parts.push(`↑${res.uploaded} synced`);
      if (res.pulled > 0) parts.push(`↓${res.pulled} from server`);
      if (res.failed > 0) parts.push(`${res.failed} failed`);
      if (parts.length > 0) flash(parts.join(" · "));
    } finally {
      syncingRef.current = false;
    }
  }, [itemsRef, applyAll, flash]);

  // Refresh from storage + config whenever the screen regains focus
  // (Settings may have saved a server or run a sync).
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void reload();
      void getApiConfig().then((cfg) => {
        if (!cancelled) setSyncOn(Boolean(cfg));
      });
      return () => {
        cancelled = true;
      };
    }, [reload])
  );

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
      await runSync();
      void runEnrichment();
    };
    void drain();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void drain();
    });
    return () => sub.remove();
  }, [loaded, add, flash, runSync, runEnrichment]);

  // one folder per platform present, plus All / Starred / Notes
  const folders = useMemo(() => foldersFromItems(items), [items]);

  // while searching, the folder grid is replaced by matching items
  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return null;
    return items.filter((i) =>
      [i.title, i.url, i.rawText, i.description, i.siteName, i.platform]
        .filter(Boolean)
        .some((v) => (v as string).toLowerCase().includes(q))
    );
  }, [items, search]);

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
      void noteItemDeleted(item);
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
    void runEnrichment();
  }, [add, draft, flash, runEnrichment]);

  const addDemoLinks = useCallback(() => {
    for (const url of DEMO_URLS) add({ text: url });
    flash("Added 3 demo links — fetching their pages…");
    void runEnrichment();
  }, [add, flash, runEnrichment]);

  const linkCount = items.filter((i) => i.kind === "link").length;
  const unsyncedCount = items.filter((i) => !i.serverId).length;

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right", "bottom"]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.header}>
          <View style={styles.headerMain}>
            <Pressable
              onLongPress={() => router.push("/diagnostics")}
              delayLongPress={400}
              accessibilityRole="button"
              accessibilityLabel="Vault"
            >
              <Text style={styles.title}>Vault</Text>
            </Pressable>
            <Text style={styles.subtitle}>
              {loaded
                ? `${items.length} saved${linkCount !== items.length ? ` · ${linkCount} links` : ""}${
                    fetchingCount > 0 ? ` · fetching ${fetchingCount}…` : ""
                  }${
                    syncOn && unsyncedCount > 0 ? ` · ${unsyncedCount} to sync` : ""
                  } · v${Constants.expoConfig?.version ?? "?"}`
                : "Loading…"}
            </Text>
          </View>
          <Pressable
            style={({ pressed }) => [styles.gearBtn, pressed && { opacity: 0.6 }]}
            onPress={() => router.push("/settings")}
            accessibilityRole="button"
            accessibilityLabel="Settings"
          >
            <Text style={styles.gear}>⚙</Text>
          </Pressable>
        </View>

        <View style={styles.searchRow}>
          <TextInput
            style={styles.input}
            value={search}
            onChangeText={setSearch}
            placeholder="Search everything"
            placeholderTextColor={c.dim}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
          />
        </View>

        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.body}
          keyboardShouldPersistTaps="handled"
        >
          {searchResults ? (
            searchResults.length === 0 ? (
              <Text style={styles.noResults}>
                Nothing matches “{search.trim()}”.
              </Text>
            ) : (
              <MasonryGrid items={searchResults} styles={styles} onLongPress={showMenu} />
            )
          ) : !loaded ? null : items.length === 0 ? (
            <EmptyState styles={styles} onDemo={addDemoLinks} />
          ) : (
            <View style={styles.folderWrap}>
              {folders.map((folder) => (
                <FolderCard
                  key={folder.key}
                  folder={folder}
                  styles={styles}
                  onPress={() => router.push(`/folder/${folder.key}`)}
                />
              ))}
            </View>
          )}
        </ScrollView>

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

function EmptyState({
  styles,
  onDemo,
}: {
  styles: ReturnType<typeof createStyles>;
  onDemo: () => void;
}) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>Your vault is empty</Text>
      <Text style={styles.emptyBody}>
        In any app — X, Instagram, YouTube, your browser — tap Share and choose{" "}
        <Text style={styles.emptyBold}>Link Vault</Text>. It saves the link with a quick
        toast and you stay right where you were. You can also paste one below.
      </Text>
      <Pressable style={styles.demoBtn} onPress={onDemo} accessibilityRole="button">
        <Text style={styles.demoBtnText}>Add 3 demo links — see capture in action</Text>
      </Pressable>
    </View>
  );
}

/**
 * Folder tile, glassmorphism: thumbnails peek out of a frosted pocket,
 * name + count centered below (stamp-album style).
 */
function FolderCard({
  folder,
  styles,
  onPress,
}: {
  folder: Folder;
  styles: ReturnType<typeof createStyles>;
  onPress: () => void;
}) {
  const noun =
    folder.key === "note" ? "note" : folder.key === "starred" ? "item" : "link";
  const nounPlural =
    folder.key === "note" ? "notes" : folder.key === "starred" ? "items" : "links";
  const top = folder.items.slice(0, 3);
  const tile = platformTile(folder.key === "note" ? "note" : folder.key, "link");

  // fan layouts: thumbnails poke out of the pocket's top edge
  const placements = [
    { left: 14, top: 8, rot: -10, z: 1 },
    { right: 14, top: 8, rot: 10, z: 1 },
    { left: "50%" as const, marginLeft: -36, top: 10, rot: -2, z: 2 },
  ];
  const used =
    top.length === 1 ? [placements[2]] : top.length === 2 ? [placements[0], placements[1]] : placements;

  return (
    <Pressable
      style={({ pressed }) => [styles.folderCard, pressed && { opacity: 0.85 }]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${folderLabel(folder.key)} folder, ${folder.items.length} items`}
    >
      <View style={styles.folderVisual}>
        {top.map((item, i) => {
          const p = used[i];
          const rot = { transform: [{ rotate: `${p.rot}deg` }] };
          const pos =
            p.left != null ? { left: p.left, marginLeft: p.marginLeft } : { right: p.right };
          return (
            <View
              key={item.id}
              style={[styles.folderThumb, pos as object, rot, { zIndex: p.z, elevation: p.z }]}
            >
              {item.thumbnailUrl ? (
                <Image
                  source={{ uri: item.thumbnailUrl }}
                  style={styles.folderThumbImg}
                  resizeMode="cover"
                />
              ) : (
                <View
                  style={[
                    styles.folderThumbImg,
                    styles.folderThumbGlyph,
                    { backgroundColor: platformTile(item.platform, item.kind).bg },
                  ]}
                >
                  <Text style={styles.folderThumbGlyphText}>
                    {platformTile(item.platform, item.kind).glyph}
                  </Text>
                </View>
              )}
            </View>
          );
        })}
        {top.length === 0 && (
          <View
            style={[
              styles.folderThumb,
              { left: "50%", marginLeft: -36, top: 10, zIndex: 2, elevation: 2 },
            ]}
          >
            <View style={[styles.folderThumbImg, styles.folderThumbGlyph, { backgroundColor: tile.bg }]}>
              <Text style={styles.folderThumbGlyphText}>{tile.glyph}</Text>
            </View>
          </View>
        )}
        {/* frosted pocket — overlaps the thumbnails' lower half */}
        <View style={styles.glassPocket} pointerEvents="none">
          <View style={styles.glassHighlight} />
        </View>
      </View>
      <Text style={styles.folderName}>{folderLabel(folder.key)}</Text>
      <Text style={styles.folderCount}>
        {folder.items.length} {folder.items.length === 1 ? noun : nounPlural}
      </Text>
    </Pressable>
  );
}

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    flex: { flex: 1 },
    safe: { flex: 1, backgroundColor: c.bg },
    header: {
      paddingHorizontal: 20,
      paddingTop: 12,
      paddingBottom: 10,
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 10,
    },
    headerMain: { flex: 1, gap: 2 },
    gearBtn: {
      marginTop: 6,
      width: 38,
      height: 38,
      borderRadius: 999,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
    },
    gear: { fontSize: 18, color: c.text },
    title: { fontSize: 32, fontWeight: "800", color: c.text, letterSpacing: -0.8 },
    subtitle: { fontSize: 13, color: c.dim },
    body: { paddingHorizontal: 20, paddingBottom: 24, gap: 4 },
    searchRow: { paddingHorizontal: 20, paddingTop: 2, paddingBottom: 10 },
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
    noResults: { color: c.dim, textAlign: "center", marginTop: 24, fontSize: 14 },
    // folder grid — glassmorphism pockets, no card chrome
    folderWrap: { flexDirection: "row", flexWrap: "wrap", gap: 14 },
    folderCard: {
      flexGrow: 1,
      flexBasis: "46%",
      alignItems: "center",
      paddingBottom: 6,
    },
    folderVisual: {
      width: "100%",
      height: 122,
      marginBottom: 8,
    },
    folderThumb: {
      position: "absolute",
      width: 72,
      height: 58,
      borderRadius: 9,
      overflow: "hidden",
      borderWidth: 2,
      borderColor: "rgba(255,255,255,0.92)",
      backgroundColor: c.surfaceAlt,
    },
    folderThumbImg: { width: "100%", height: "100%" },
    folderThumbGlyph: { alignItems: "center", justifyContent: "center" },
    folderThumbGlyphText: { fontSize: 18, fontWeight: "800", color: "#FFFFFF", opacity: 0.92 },
    glassPocket: {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      height: 86,
      borderRadius: 18,
      backgroundColor: c.glassFill,
      borderWidth: 1,
      borderColor: c.glassBorder,
      zIndex: 5,
      elevation: 5,
      overflow: "hidden",
    },
    glassHighlight: {
      position: "absolute",
      top: 5,
      left: 14,
      right: 14,
      height: 2,
      borderRadius: 1,
      backgroundColor: c.glassHighlight,
    },
    folderName: { fontSize: 15.5, fontWeight: "700", color: c.text, textAlign: "center" },
    folderCount: { fontSize: 12.5, color: c.dim, marginTop: 2, textAlign: "center" },
    // capture bar
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
    // empty + snackbar
    empty: { flex: 1, padding: 32, justifyContent: "center", gap: 10 },
    emptyTitle: { fontSize: 20, fontWeight: "700", color: c.text, textAlign: "center" },
    emptyBody: { fontSize: 15, color: c.dim, textAlign: "center", lineHeight: 22 },
    emptyBold: { fontWeight: "700", color: c.text },
    demoBtn: {
      alignSelf: "center",
      backgroundColor: c.surface,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 14,
      paddingHorizontal: 16,
      paddingVertical: 10,
      marginTop: 4,
    },
    demoBtnText: { color: c.accent, fontWeight: "700", fontSize: 14 },
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
