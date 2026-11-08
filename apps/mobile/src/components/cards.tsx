import { router } from "expo-router";
import React, { useEffect, useState } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";

import { domainOf, itemDisplayTitle, type VaultItem } from "@/lib/store";
import { platformTile, type ThemeColors } from "@/lib/theme";

/** Relative-time label shared by every item surface. */
export function formatWhen(iso: string): string {
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

/** Styles shared by all item surfaces (home search, folder grid, canvas). */
export function createCardStyles(c: ThemeColors) {
  return StyleSheet.create({
    masonry: { flexDirection: "row", gap: 12 },
    masonryCol: { flex: 1, gap: 12 },
    card: {
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
    tileFlex: {
      alignItems: "center",
      justifyContent: "center",
      overflow: "hidden",
      width: "100%",
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
      minWidth: 26,
      height: 20,
      paddingHorizontal: 7,
      alignItems: "center",
      justifyContent: "center",
    },
    badgeText: { color: "#FFFFFF", fontSize: 11, fontWeight: "700", lineHeight: 13 },
    favBadge: {
      position: "absolute",
      top: 8,
      left: 8,
      backgroundColor: "rgba(0,0,0,0.55)",
      borderRadius: 999,
      minWidth: 22,
      height: 22,
      paddingHorizontal: 4,
      alignItems: "center",
      justifyContent: "center",
    },
    favBadgeText: { color: "#F5B83D", fontSize: 12, lineHeight: 14 },
    pendingBadge: {
      position: "absolute",
      bottom: 8,
      left: 8,
      backgroundColor: "rgba(0,0,0,0.45)",
      borderRadius: 999,
      minWidth: 22,
      height: 19,
      paddingHorizontal: 7,
      alignItems: "center",
      justifyContent: "center",
    },
    pendingBadgeText: { color: "#FFFFFF", fontSize: 12, fontWeight: "700", lineHeight: 14 },
    cardBody: { padding: 12, gap: 5 },
    cardTitle: { fontSize: 14.5, fontWeight: "600", color: c.text, lineHeight: 19 },
    cardDetail: { fontSize: 12, color: c.dim },
    cardWhen: { fontSize: 11, color: c.dim, marginTop: 2 },
  });
}

export type CardStyles = ReturnType<typeof createCardStyles>;

/** Tile with the captured thumbnail at its natural shape; colored glyph otherwise. */
export function CardTile({ item, styles }: { item: VaultItem; styles: CardStyles }) {
  const [broken, setBroken] = useState(false);
  const [ratio, setRatio] = useState<number | null>(null);
  const tile = platformTile(item.platform, item.kind);
  const showImage = !!item.thumbnailUrl && !broken;

  useEffect(() => {
    setBroken(false);
    setRatio(null);
    if (!item.thumbnailUrl) return;
    let alive = true;
    Image.getSize(
      item.thumbnailUrl,
      (w, h) => {
        if (alive && w > 0 && h > 0) setRatio(w / h);
      },
      () => {}
    );
    return () => {
      alive = false;
    };
  }, [item.thumbnailUrl]);

  if (!showImage) {
    return (
      <View style={[styles.tile, { backgroundColor: tile.bg }]}>
        <Text style={[styles.tileGlyph, tile.glyph.length > 1 && styles.tileGlyphSmall]}>
          {tile.glyph}
        </Text>
        <TileBadges item={item} styles={styles} />
      </View>
    );
  }

  // vertical images get a tall tile (clamped so extreme reels don't take over)
  const tileStyle =
    ratio != null
      ? [styles.tileFlex, { aspectRatio: Math.min(Math.max(ratio, 0.75), 2.4) }]
      : styles.tile;

  return (
    <View style={tileStyle}>
      <Image
        source={{ uri: item.thumbnailUrl! }}
        style={styles.tileImage}
        resizeMode="cover"
        onError={() => setBroken(true)}
      />
      <TileBadges item={item} styles={styles} />
    </View>
  );
}

function TileBadges({ item, styles }: { item: VaultItem; styles: CardStyles }) {
  return (
    <>
      {item.kind === "link" && !item.enrichmentLevel && (
        <View style={styles.pendingBadge}>
          <Text style={styles.pendingBadgeText}>…</Text>
        </View>
      )}
      {item.favorite && (
        <View style={styles.favBadge}>
          <Text style={styles.favBadgeText}>★</Text>
        </View>
      )}
      {item.seenCount > 1 && (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>×{item.seenCount}</Text>
        </View>
      )}
    </>
  );
}

export function ItemCard({
  item,
  styles,
  onPress,
  onLongPress,
}: {
  item: VaultItem;
  styles: CardStyles;
  onPress: () => void;
  onLongPress?: () => void;
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

/** Two-column masonry of item cards. */
export function MasonryGrid({
  items,
  styles,
  onLongPress,
}: {
  items: VaultItem[];
  styles: CardStyles;
  onLongPress?: (item: VaultItem) => void;
}) {
  return (
    <View style={styles.masonry}>
      {[0, 1].map((col) => (
        <View key={col} style={styles.masonryCol}>
          {items
            .filter((_, i) => i % 2 === col)
            .map((item) => (
              <ItemCard
                key={item.id}
                item={item}
                styles={styles}
                onPress={() => router.push(`/item/${item.id}`)}
                onLongPress={onLongPress ? () => onLongPress(item) : undefined}
              />
            ))}
        </View>
      ))}
    </View>
  );
}
