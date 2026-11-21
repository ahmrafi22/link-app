import { router, useLocalSearchParams } from "expo-router";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
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

import { createCardStyles, FadeUp, formatWhen, MasonryGrid, PressableScale, type CardStyles } from "@/components/cards";
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
 * Pinch to zoom with two fingers (double-tap resets AND re-centers on the
 * content). Zoom scales the whole board — cards, gaps, rotations — via a
 * transform with a top-left origin inside ScrollViews whose content size is
 * base × zoom, so panning reaches the true scaled edges.
 *
 * Opening: the board auto-scrolls to the visual center of the scattered
 * items (bounding-box centroid), not the middle of the empty canvas.
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
  const centeredRef = useRef(false);

  // Row-window virtualization: the board is a deterministic grid, so only the
  // rows near the viewport are mounted (± margin rows). Keeps both memory and
  // pinch/pan re-renders flat as the vault grows.
  const vOffsetRef = useRef(0);
  const [rowWindow, setRowWindow] = useState<[number, number]>([0, 12]);
  const recomputeWindow = useCallback(() => {
    const cellScaled = CELL_H * zoomRef.current;
    const first = Math.max(0, Math.floor((vOffsetRef.current - 40 * zoomRef.current) / cellScaled) - 2);
    const visible = Math.ceil(vh / cellScaled) + 1;
    const last = Math.min(
      Math.max(1, Math.ceil(items.length / COLS)) - 1,
      first + visible + 3 // extra rows cover the ±28px placement jitter
    );
    setRowWindow((prev) => (prev[0] === first && prev[1] === last ? prev : [first, last]));
  }, [items.length, vh]);

  const onVScroll = useCallback(
    (e: { nativeEvent: { contentOffset: { y: number } } }) => {
      vOffsetRef.current = e.nativeEvent.contentOffset.y;
      recomputeWindow();
    },
    [recomputeWindow]
  );
  // zoom changes and folder switches shift the visible window too
  useEffect(() => {
    recomputeWindow();
  }, [recomputeWindow, zoom]);

  const applyZoom = useCallback((z: number) => {
    const clamped = clampZoom(z);
    zoomRef.current = clamped;
    setZoom(clamped);
  }, []);

  // centroid of where the cards actually sit (bounding box of placements)
  const contentCenter = useMemo(() => {
    if (items.length === 0) return null;
    const pts = items.map((item, i) => {
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      const h = hashId(item.id);
      const jx = (h % 56) - 28;
      const jy = ((h >> 3) % 56) - 28;
      return { x: 40 + col * CELL_W + jx, y: 40 + row * CELL_H + jy };
    });
    const minX = Math.min(...pts.map((p) => p.x));
    const maxX = Math.max(...pts.map((p) => p.x)) + 124;
    const minY = Math.min(...pts.map((p) => p.y));
    const maxY = Math.max(...pts.map((p) => p.y)) + 170;
    return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
  }, [items]);

  const recenter = useCallback(() => {
    if (!contentCenter) return;
    const s = zoomRef.current;
    hRef.current?.scrollTo({
      x: Math.max(0, contentCenter.cx * s - vw / 2),
      animated: true,
    });
    vRef.current?.scrollTo({
      y: Math.max(0, contentCenter.cy * s - vh / 2),
      animated: true,
    });
  }, [contentCenter, vw, vh]);

  // run on gesture end too — fingers-only zoom
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
        if (success) {
          applyZoom(1);
          recenter();
        }
      });
    return Gesture.Exclusive(pinch, doubleTap);
  }, [applyZoom, recenter]);

  const rows = Math.max(1, Math.ceil(items.length / COLS));
  const boardW = COLS * CELL_W + 80;
  const boardH = rows * CELL_H + 80;
  const contentW = boardW * zoom;
  const contentH = boardH * zoom;

  // center on the content once the ScrollViews have laid out (both signals,
  // because scrollTo before layout is a silent no-op)
  const onInnerContentSize = useCallback(() => {
    if (centeredRef.current) return;
    centeredRef.current = true;
    recenter();
  }, [recenter]);
  useEffect(() => {
    const t = setTimeout(() => {
      if (!centeredRef.current) {
        centeredRef.current = true;
        recenter();
      }
    }, 350);
    return () => clearTimeout(t);
  }, [recenter]);
  // re-center when switching folders
  useEffect(() => {
    centeredRef.current = false;
  }, [items]);

  return (
    <View style={styles.flex}>
      <GestureDetector gesture={gesture}>
        <ScrollView
          ref={vRef}
          style={styles.flex}
          showsVerticalScrollIndicator={false}
          scrollEnabled={!pinching}
          contentContainerStyle={styles.grow}
          onScroll={onVScroll}
          scrollEventThrottle={48}
        >
          <ScrollView
            ref={hRef}
            horizontal
            showsHorizontalScrollIndicator={false}
            scrollEnabled={!pinching}
            onContentSizeChange={onInnerContentSize}
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
                const row = Math.floor(i / COLS);
                if (row < rowWindow[0] || row > rowWindow[1]) return null;
                const col = i % COLS;
                const h = hashId(item.id);
                const jx = ((h % 56) - 28);
                const jy = (((h >> 3) % 56) - 28);
                const rot = ((h >> 6) % 22) - 11;
                return (
                  <View
                    key={item.id}
                    style={[
                      styles.canvasItem,
                      {
                        left: 40 + col * CELL_W + jx,
                        top: 40 + row * CELL_H + jy,
                        transform: [{ rotate: `${rot}deg` }],
                      },
                    ]}
                  >
                    <FadeUp index={i}>
                      <PressableScale
                        onPress={() => onOpen(item)}
                        pressedScale={0.92}
                        accessibilityRole="button"
                        accessibilityLabel={itemDisplayTitle(item)}
                      >
                        <CanvasItemCard item={item} styles={styles} />
                      </PressableScale>
                    </FadeUp>
                  </View>
                );
              })}
            </View>
          </ScrollView>
        </ScrollView>
      </GestureDetector>
    </View>
  );
}

const CanvasItemCard = memo(function CanvasItemCard({
  item,
  styles,
}: {
  item: VaultItem;
  styles: FolderStyles;
}) {
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
});

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
  });
}
