import { router, useLocalSearchParams } from "expo-router";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  FadeInDown,
  useSharedValue,
  useAnimatedStyle,
  useAnimatedReaction,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import * as Haptics from "expo-haptics";
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

import { createCardStyles, formatWhen, MasonryGrid, PressableScale, type CardStyles } from "@/components/cards";
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

// entrance stagger: only the first items animate (content the user asked for),
// and each card plays at most once per session — a windowed re-mount must
// never re-fire the entrance or the board flickers while panning
const ENTRANCE_ITEMS = 10;
const ENTRANCE_PLAYED = new Set<string>();
const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);

function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 20) / 20));
}

function clampZoomWorklet(z: number): number {
  "worklet";
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

  const openItem = useCallback((item: VaultItem) => {
    router.push(`/item/${item.id}`);
  }, []);

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
        <CanvasBoard items={folderItems} styles={styles} onOpen={openItem} />
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
 * One positioned canvas card, fully memoized: during pinch/pan re-renders the
 * entire card subtree skips unless this item's data actually changed (props
 * are stable — item reference, memoized styles, useCallback'd onOpen).
 */
const CanvasCard = memo(function CanvasCard({
  item,
  styles,
  onOpen,
  index,
}: {
  item: VaultItem;
  styles: FolderStyles;
  onOpen: (item: VaultItem) => void;
  index: number;
}) {
  const col = index % COLS;
  const row = Math.floor(index / COLS);
  const h = hashId(item.id);
  const jx = h % 56 - 28;
  const jy = ((h >> 3) % 56) - 28;
  const rot = ((h >> 6) % 22) - 11;
  // builders live in memo, never inline JSX (rebuilt builders re-fire the
  // animation on every render); an already-seen card mounts with no entrance
  const entering = useMemo(() => {
    if (index >= ENTRANCE_ITEMS || ENTRANCE_PLAYED.has(item.id)) return undefined;
    ENTRANCE_PLAYED.add(item.id);
    return FadeInDown.duration(250).delay(index * 40).easing(EASE_OUT);
  }, [item.id, index]);
  return (
    <View
      style={[
        styles.canvasItem,
        {
          left: 40 + col * CELL_W + jx,
          top: 40 + row * CELL_H + jy,
          transform: [{ rotate: `${rot}deg` }],
        },
      ]}
    >
      <Animated.View entering={entering}>
        <PressableScale
          onPress={() => onOpen(item)}
          accessibilityRole="button"
          accessibilityLabel={itemDisplayTitle(item)}
        >
          <CanvasItemCard item={item} styles={styles} />
        </PressableScale>
      </Animated.View>
    </View>
  );
});

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
  // the live zoom lives in a shared value — the transform runs on the UI
  // thread every frame; React state only mirrors the same quantized steps it
  // always did (content size, recenter math, window recompute)
  const zoomSV = useSharedValue(1);
  const pinchBase = useSharedValue(1);
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  const [pinching, setPinching] = useState(false);
  const centeredRef = useRef(false);

  const applyZoom = useCallback((z: number) => {
    const clamped = clampZoom(z);
    zoomRef.current = clamped;
    setZoom(clamped);
  }, []);

  // fire back to the RN runtime only when the quantized step changes —
  // never per frame (the "do something at a threshold" pattern)
  useAnimatedReaction(
    () => Math.round(zoomSV.get() * 20) / 20,
    (q, prev) => {
      if (q !== prev) scheduleOnRN(applyZoom, q);
    },
    [applyZoom]
  );

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

  // fingers-only zoom: the pinch runs as worklets on the UI thread (motion
  // never waits for JS); the double-tap reset is a discrete JS-side event and
  // gets the "snapped home" haptic in the same frame as the recenter
  const gesture = useMemo(() => {
    const pinch = Gesture.Pinch()
      .onBegin(() => {
        pinchBase.set(zoomSV.get());
        scheduleOnRN(setPinching, true);
      })
      .onUpdate((e) => {
        zoomSV.set(clampZoomWorklet(pinchBase.get() * e.scale));
      })
      .onEnd(() => {
        scheduleOnRN(setPinching, false);
      });
    const doubleTap = Gesture.Tap()
      .runOnJS(true)
      .numberOfTaps(2)
      .onEnd((_e, success) => {
        if (success) {
          zoomSV.set(1);
          applyZoom(1);
          recenter();
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        }
      });
    return Gesture.Exclusive(pinch, doubleTap);
  }, [applyZoom, recenter]);

  // the board's visual scale — UI thread, every frame, no React renders
  const boardStyle = useAnimatedStyle(() => ({
    transform: [{ scale: zoomSV.get() }],
  }));

  const rows = Math.max(1, Math.ceil(items.length / COLS));
  const boardW = COLS * CELL_W + 80;
  const boardH = rows * CELL_H + 80;
  const contentW = boardW * zoom;
  const contentH = boardH * zoom;

  // indices of the mounted window only — the map below stays O(visible)
  const visibleIdx = useMemo(() => {
    const out: number[] = [];
    for (let i = 0; i < items.length; i++) {
      const row = Math.floor(i / COLS);
      if (row < rowWindow[0]) continue;
      if (row > rowWindow[1]) break;
      out.push(i);
    }
    return out;
  }, [items, rowWindow]);

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
            <Animated.View
              style={[
                {
                  width: boardW,
                  height: boardH,
                  transformOrigin: "top left",
                },
                boardStyle,
              ]}
            >
              {visibleIdx.map((i) => {
                const item = items[i];
                return (
                  <CanvasCard
                    key={item.id}
                    item={item}
                    styles={styles}
                    onOpen={onOpen}
                    index={i}
                  />
                );
              })}
            </Animated.View>
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
