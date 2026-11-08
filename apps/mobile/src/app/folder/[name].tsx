import { router, useLocalSearchParams } from "expo-router";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type ImageStyle,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { createCardStyles, formatWhen, MasonryGrid, type CardStyles } from "@/components/cards";
import { folderLabel, itemsInFolder } from "@/lib/folders";
import { itemDisplayTitle, useVault, type VaultItem } from "@/lib/store";
import { platformTile, useTheme, type ThemeColors } from "@/lib/theme";

/**
 * Folder view — "Gallery" style. Default is an infinite canvas: items are
 * scattered like stamps on a pannable surface (deterministic pseudo-random
 * placement + slight rotation per item). The header toggle switches to the
 * two-column masonry grid.
 */

const CELL_W = 168;
const CELL_H = 196;
const COLS = 5;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;

function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 20) / 20));
}

function hashId(s: string): number {
  let h = 7;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export default function FolderScreen() {
  const c = useTheme();
  const styles = useMemo(
    () => StyleSheet.create({ ...createCardStyles(c), ...createStyles(c) }),
    [c]
  );
  const params = useLocalSearchParams<{ name: string }>();
  const key = typeof params.name === "string" ? params.name : "all";

  const { items, loaded } = useVault();
  const folderItems = useMemo(() => itemsInFolder(items, key), [items, key]);
  const [view, setView] = useState<"canvas" | "grid">("canvas");

  const noun = key === "note" ? "notes" : "items";

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <View style={styles.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button">
          <Text style={styles.back}>‹</Text>
        </Pressable>
        <View style={styles.titleWrap}>
          <Text style={styles.title}>{folderLabel(key)}</Text>
          <Text style={styles.subtitle}>
            {loaded ? `${folderItems.length} ${noun}` : ""}
          </Text>
        </View>
        <View style={styles.seg}>
          <Pressable
            style={[styles.segBtn, view === "canvas" && styles.segBtnActive]}
            onPress={() => setView("canvas")}
            accessibilityRole="button"
            accessibilityState={{ selected: view === "canvas" }}
          >
            <Text style={[styles.segText, view === "canvas" && styles.segTextActive]}>✦</Text>
          </Pressable>
          <Pressable
            style={[styles.segBtn, view === "grid" && styles.segBtnActive]}
            onPress={() => setView("grid")}
            accessibilityRole="button"
            accessibilityState={{ selected: view === "grid" }}
          >
            <Text style={[styles.segText, view === "grid" && styles.segTextActive]}>▦</Text>
          </Pressable>
        </View>
      </View>

      {!loaded ? null : folderItems.length === 0 ? (
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyText}>
            Nothing here yet — share a link into this folder.
          </Text>
        </View>
      ) : view === "canvas" ? (
        <CanvasBoard
          items={folderItems}
          styles={styles}
          onOpen={(item) => router.push(`/item/${item.id}`)}
        />
      ) : (
        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.gridPad}
          showsVerticalScrollIndicator={false}
        >
          <MasonryGrid items={folderItems} styles={styles} />
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

type FolderStyles = CardStyles & ReturnType<typeof createStyles>;

/**
 * Pannable scattered board: a vertical ScrollView wrapping a horizontal one.
 * Pinch to zoom (or the glass −/+ chips; double-tap resets). Zoom scales the
 * whole board — cards, gaps, rotations — via a transform with a top-left
 * origin inside ScrollViews whose content size is base × zoom, so panning
 * reaches the true scaled edges without fighting the gesture.
 */
function CanvasBoard({
  items,
  styles,
  onOpen,
}: {
  items: VaultItem[];
  styles: FolderStyles;
  onOpen: (item: VaultItem) => void;
}) {
  const { width: vw, height: vh } = useWindowDimensions();
  const vRef = useRef<ScrollView>(null);
  const hRef = useRef<ScrollView>(null);
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  const [pinching, setPinching] = useState(false);
  const baseRef = useRef(1);

  const applyZoom = useCallback((z: number) => {
    const clamped = clampZoom(z);
    zoomRef.current = clamped;
    setZoom(clamped);
  }, []);

  // runOnJS(true): gesture callbacks stay on the JS thread so plain
  // setState works whether or not Reanimated worklets are active.
  const gesture = useMemo(() => {
    const pinch = Gesture.Pinch()
      .runOnJS(true)
      .onBegin(() => {
        baseRef.current = zoomRef.current;
        setPinching(true);
      })
      .onUpdate((e) => applyZoom(baseRef.current * e.scale))
      .onEnd(() => setPinching(false));
    const doubleTap = Gesture.Tap()
      .runOnJS(true)
      .numberOfTaps(2)
      .onEnd((_e, success) => {
        if (success) applyZoom(1);
      });
    return Gesture.Exclusive(pinch, doubleTap);
  }, [applyZoom]);

  const rows = Math.max(1, Math.ceil(items.length / COLS));
  const boardW = COLS * CELL_W + 80;
  const boardH = rows * CELL_H + 80;
  const contentW = boardW * zoom;
  const contentH = boardH * zoom;

  // start centered so the scatter reads as a canvas, not a list
  useEffect(() => {
    hRef.current?.scrollTo({ x: Math.max(0, (boardW - vw) / 2), animated: false });
    vRef.current?.scrollTo({
      y: Math.max(0, Math.min(boardH - vh, (boardH - vh) / 2)),
      animated: false,
    });
    // center only on mount / item-count change — not on zoom changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardW, boardH, vw, vh]);

  return (
    <View style={styles.flex}>
      <GestureDetector gesture={gesture}>
        <ScrollView
          ref={vRef}
          style={styles.flex}
          showsVerticalScrollIndicator={false}
          scrollEnabled={!pinching}
          contentContainerStyle={styles.grow}
        >
          <ScrollView
            ref={hRef}
            horizontal
            showsHorizontalScrollIndicator={false}
            scrollEnabled={!pinching}
            style={{ height: contentH }}
            contentContainerStyle={{ width: contentW }}
          >
            <View
              style={{
                width: boardW,
                height: boardH,
                transform: [{ scale: zoom }],
                transformOrigin: "top left",
              }}
            >
              {items.map((item, i) => {
                const col = i % COLS;
                const row = Math.floor(i / COLS);
                const h = hashId(item.id);
                const jx = ((h % 56) - 28);
                const jy = (((h >> 3) % 56) - 28);
                const rot = ((h >> 6) % 22) - 11;
                return (
                  <Pressable
                    key={item.id}
                    onPress={() => onOpen(item)}
                    style={[
                      styles.canvasItem,
                      {
                        left: 40 + col * CELL_W + jx,
                        top: 40 + row * CELL_H + jy,
                        transform: [{ rotate: `${rot}deg` }],
                      },
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={itemDisplayTitle(item)}
                  >
                    <CanvasItemCard item={item} styles={styles} />
                  </Pressable>
                );
              })}
            </View>
          </ScrollView>
        </ScrollView>
      </GestureDetector>

      {/* zoom controls — box-none so the canvas scrolls between the chips */}
      <View style={styles.zoomBar} pointerEvents="box-none">
        <Pressable
          style={({ pressed }) => [styles.zoomBtn, pressed && { opacity: 0.6 }]}
          onPress={() => applyZoom(zoomRef.current - 0.25)}
          accessibilityRole="button"
          accessibilityLabel="Zoom out"
        >
          <Text style={styles.zoomBtnText}>−</Text>
        </Pressable>
        <View style={styles.zoomLevel}>
          <Text style={styles.zoomLevelText}>{Math.round(zoom * 100)}%</Text>
        </View>
        <Pressable
          style={({ pressed }) => [styles.zoomBtn, pressed && { opacity: 0.6 }]}
          onPress={() => applyZoom(zoomRef.current + 0.25)}
          accessibilityRole="button"
          accessibilityLabel="Zoom in"
        >
          <Text style={styles.zoomBtnText}>+</Text>
        </Pressable>
      </View>
    </View>
  );
}

function CanvasItemCard({ item, styles }: { item: VaultItem; styles: FolderStyles }) {
  const tile = platformTile(item.platform, item.kind);
  const showImage = !!item.thumbnailUrl;
  return (
    <View style={styles.canvasCard}>
      <View style={[styles.canvasImageWrap, !showImage && { backgroundColor: tile.bg }]}>
        {showImage ? (
          <Image
            source={{ uri: item.thumbnailUrl! }}
            style={canvasImageStyle}
            resizeMode="cover"
          />
        ) : (
          <Text style={styles.canvasGlyph}>{tile.glyph}</Text>
        )}
        {item.seenCount > 1 && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>×{item.seenCount}</Text>
          </View>
        )}
        {item.favorite && (
          <View style={styles.favBadge}>
            <Text style={styles.favBadgeText}>★</Text>
          </View>
        )}
      </View>
      <View style={styles.canvasBody}>
        <Text style={styles.canvasTitle} numberOfLines={1}>
          {itemDisplayTitle(item)}
        </Text>
        <Text style={styles.canvasWhen}>{formatWhen(item.lastSeenAt || item.createdAt)}</Text>
      </View>
    </View>
  );
}

const canvasImageStyle: ImageStyle = { width: "100%", height: "100%" };

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    flex: { flex: 1 },
    grow: { flexGrow: 1 },
    safe: { flex: 1, backgroundColor: c.bg },
    topBar: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 16,
      paddingTop: 6,
      paddingBottom: 10,
      gap: 8,
    },
    back: { fontSize: 34, color: c.text, lineHeight: 38 },
    titleWrap: { flex: 1, alignItems: "center" },
    title: { fontSize: 17, fontWeight: "800", color: c.text },
    subtitle: { fontSize: 12, color: c.dim },
    seg: {
      flexDirection: "row",
      backgroundColor: c.surface,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: c.border,
      overflow: "hidden",
    },
    segBtn: { width: 40, height: 28, alignItems: "center", justifyContent: "center" },
    segBtnActive: { backgroundColor: c.pillBg },
    segText: { fontSize: 14, color: c.dim, fontWeight: "700" },
    segTextActive: { color: c.onAccent },
    emptyWrap: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
    emptyText: { color: c.dim, textAlign: "center", fontSize: 15, lineHeight: 22 },
    gridPad: { paddingHorizontal: 20, paddingBottom: 24, paddingTop: 4 },
    // canvas
    canvasItem: { position: "absolute", width: 124 },
    canvasCard: {
      backgroundColor: c.surface,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.border,
      padding: 5,
      elevation: 3,
      shadowColor: "#000",
      shadowOpacity: 0.3,
      shadowRadius: 6,
      shadowOffset: { width: 0, height: 3 },
    },
    canvasImageWrap: {
      height: 88,
      borderRadius: 8,
      overflow: "hidden",
      alignItems: "center",
      justifyContent: "center",
    },
    canvasGlyph: { fontSize: 26, fontWeight: "800", color: "#FFFFFF", opacity: 0.92 },
    canvasBody: { paddingTop: 5, paddingBottom: 2, paddingHorizontal: 2, gap: 1 },
    canvasTitle: { fontSize: 11, fontWeight: "600", color: c.text },
    canvasWhen: { fontSize: 9.5, color: c.dim },
    // zoom controls (glass chips, bottom-right)
    zoomBar: {
      position: "absolute",
      right: 14,
      bottom: 16,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    zoomBtn: {
      width: 38,
      height: 38,
      borderRadius: 999,
      backgroundColor: c.glassFill,
      borderWidth: 1,
      borderColor: c.glassBorder,
      alignItems: "center",
      justifyContent: "center",
      elevation: 4,
      shadowColor: "#000",
      shadowOpacity: 0.25,
      shadowRadius: 6,
      shadowOffset: { width: 0, height: 3 },
    },
    zoomBtnText: { color: c.text, fontSize: 22, fontWeight: "700", marginTop: -2 },
    zoomLevel: {
      minWidth: 52,
      height: 28,
      borderRadius: 999,
      backgroundColor: c.glassFill,
      borderWidth: 1,
      borderColor: c.glassBorder,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 8,
    },
    zoomLevelText: { color: c.text, fontSize: 12, fontWeight: "700" },
  });
}
