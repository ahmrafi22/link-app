import * as Clipboard from "expo-clipboard";
import * as WebBrowser from "expo-web-browser";
import { useShareIntentContext } from "expo-share-intent";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { itemDisplayTitle, useVault, type VaultItem } from "@/lib/store";
import { useTheme, type ThemeColors } from "@/lib/theme";

export default function InboxScreen() {
  const c = useTheme();
  const styles = useMemo(() => createStyles(c), [c]);

  const { items, loaded, add, remove } = useVault();
  const { hasShareIntent, shareIntent, resetShareIntent, error } =
    useShareIntentContext();

  const [search, setSearch] = useState("");
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

  // receive shared links/text from the share sheet
  useEffect(() => {
    if (!hasShareIntent || !shareIntent) return;
    const { webUrl, text, meta } = shareIntent;
    if (webUrl || text) {
      const result = add({
        webUrl: webUrl ?? null,
        text: text ?? null,
        title: meta?.title ?? null,
      });
      if (result) {
        flash(
          result.duplicate
            ? `Already in your vault — ${result.item.seenCount} saves`
            : "Saved to your vault"
        );
      }
    } else if (shareIntent.files?.length) {
      flash("Only links and text are saved");
    }
    resetShareIntent();
  }, [hasShareIntent, shareIntent, resetShareIntent, add, flash]);

  useEffect(() => {
    if (error) flash(`Share failed: ${error}`);
  }, [error, flash]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((i) =>
      [i.title, i.url, i.rawText, i.platform]
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
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.header}>
          <View style={styles.flex}>
            <Text style={styles.title}>Link Vault</Text>
            <Text style={styles.subtitle}>
              {loaded
                ? `${items.length} saved${linkCount !== items.length ? ` · ${linkCount} links` : ""}`
                : "Loading…"}
            </Text>
          </View>
        </View>

        <View style={styles.inputRow}>
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
            style={({ pressed }) => [styles.saveButton, pressed && { opacity: 0.7 }]}
            onPress={saveDraft}
            accessibilityLabel="Save pasted content"
          >
            <Text style={styles.saveButtonText}>Save</Text>
          </Pressable>
        </View>

        <View style={[styles.inputRow, styles.searchRow]}>
          <TextInput
            style={[styles.input, styles.flex]}
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
            contentContainerStyle={styles.listContent}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => (
              <ItemRow
                item={item}
                styles={styles}
                onPress={() => (item.url ? void openLink(item.url) : showMenu(item))}
                onLongPress={() => showMenu(item)}
                onDelete={() => confirmDelete(item)}
              />
            )}
            ListEmptyComponent={
              <Text style={styles.noResults}>Nothing matches “{search.trim()}”.</Text>
            }
          />
        )}

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
        <Text style={styles.emptyBold}>Link Vault</Text>. The link lands here without
        leaving the app. You can also paste one above.
      </Text>
    </View>
  );
}

function ItemRow({
  item,
  styles,
  onPress,
  onLongPress,
  onDelete,
}: {
  item: VaultItem;
  styles: ReturnType<typeof createStyles>;
  onPress: () => void;
  onLongPress: () => void;
  onDelete: () => void;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.75 }]}
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole={item.url ? "link" : "button"}
    >
      <View style={styles.rowBody}>
        <View style={styles.rowMeta}>
          <Text style={styles.chip}>
            {item.kind === "link" ? (item.platform ?? "link") : "note"}
          </Text>
          <Text style={styles.when}>{formatWhen(item.lastSeenAt || item.createdAt)}</Text>
          {item.seenCount > 1 && <Text style={styles.seenCount}>×{item.seenCount}</Text>}
        </View>
        <Text style={styles.rowTitle} numberOfLines={2}>
          {itemDisplayTitle(item)}
        </Text>
        {item.url ? (
          <Text style={styles.rowUrl} numberOfLines={1}>
            {item.url}
          </Text>
        ) : null}
        {item.kind === "text" && item.rawText ? (
          <Text style={styles.rowUrl} numberOfLines={3}>
            {item.rawText}
          </Text>
        ) : null}
      </View>
      <Pressable
        onPress={onDelete}
        hitSlop={12}
        style={styles.deleteButton}
        accessibilityLabel="Delete item"
      >
        <Text style={styles.deleteText}>✕</Text>
      </Pressable>
    </Pressable>
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
      flexDirection: "row",
      alignItems: "flex-end",
      paddingHorizontal: 20,
      paddingTop: 8,
      paddingBottom: 12,
    },
    title: { fontSize: 28, fontWeight: "800", color: c.text, letterSpacing: -0.5 },
    subtitle: { marginTop: 2, fontSize: 13, color: c.dim },
    inputRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 16,
      marginBottom: 8,
    },
    searchRow: { marginBottom: 4 },
    input: {
      backgroundColor: c.surface,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: Platform.OS === "ios" ? 12 : 9,
      fontSize: 15,
      color: c.text,
    },
    saveButton: {
      backgroundColor: c.accent,
      borderRadius: 12,
      paddingHorizontal: 16,
      paddingVertical: 12,
    },
    saveButtonText: { color: "#fff", fontWeight: "700", fontSize: 15 },
    listContent: { paddingHorizontal: 16, paddingBottom: 96, gap: 8, paddingTop: 8 },
    row: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: c.surface,
      borderColor: c.border,
      borderWidth: 1,
      borderRadius: 14,
      padding: 14,
    },
    rowBody: { flex: 1, gap: 6 },
    rowMeta: { flexDirection: "row", alignItems: "center", gap: 8 },
    chip: {
      fontSize: 10,
      fontWeight: "800",
      color: c.accent,
      backgroundColor: c.accentSoft,
      borderRadius: 6,
      overflow: "hidden",
      paddingHorizontal: 6,
      paddingVertical: 2,
      textTransform: "uppercase",
      letterSpacing: 0.5,
    },
    when: { fontSize: 12, color: c.dim },
    seenCount: { fontSize: 12, fontWeight: "700", color: c.dim },
    rowTitle: { fontSize: 15.5, fontWeight: "600", color: c.text, lineHeight: 20 },
    rowUrl: { fontSize: 13, color: c.dim },
    deleteButton: {
      marginLeft: 8,
      padding: 6,
      borderRadius: 10,
      backgroundColor: c.accentSoft,
    },
    deleteText: { color: c.danger, fontSize: 14, fontWeight: "700" },
    empty: { flex: 1, padding: 32, justifyContent: "center", gap: 10 },
    emptyTitle: { fontSize: 20, fontWeight: "700", color: c.text, textAlign: "center" },
    emptyBody: { fontSize: 15, color: c.dim, textAlign: "center", lineHeight: 22 },
    emptyBold: { fontWeight: "700", color: c.text },
    noResults: { color: c.dim, textAlign: "center", marginTop: 24, fontSize: 14 },
    snackbar: {
      position: "absolute",
      bottom: 28,
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
