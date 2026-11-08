import { useCallback, useEffect, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_KEY = "linkvault.items.v1";

export type VaultItem = {
  id: string;
  kind: "link" | "text";
  /** Original URL as received (links only). */
  url: string | null;
  /** Normalized URL used for deduplication (links only). */
  urlKey: string | null;
  title: string | null;
  /** Caption / extra text shared along with the link, or the note body. */
  rawText: string | null;
  platform: string | null;
  createdAt: string;
  lastSeenAt: string;
  seenCount: number;
  /** On-device extraction results (plan: hybrid device-assisted model). */
  description: string | null;
  /** og:image / platform thumbnail — by URL only, no object storage. */
  thumbnailUrl: string | null;
  siteName: string | null;
  /** Platform-specific bits (subreddit, score, author, stars…). */
  meta: Record<string, string | number> | null;
  /** full = platform fetch · metadata = OG tags · url_only = nothing worked */
  enrichmentLevel: "full" | "metadata" | "url_only" | null;
  enrichedAt: string | null;
  enrichAttempts: number;
  favorite: boolean;
  /** Server row id once the item has been uploaded (Phase ② sync). */
  serverId: string | null;
  /** Last successful upload time; null = still in the outbox. */
  syncedAt: string | null;
  /** Server pipeline status (pending/ready/failed) — drives the retry UI. */
  serverStatus: string | null;
  /** AI-assigned category (denormalized from the server's categories table). */
  categoryId: string | null;
  categoryName: string | null;
};

const PLATFORM_MAP: Array<[string[], string]> = [
  [["x.com", "twitter.com", "t.co"], "x"],
  [["instagram.com"], "instagram"],
  [["facebook.com", "fb.watch", "fb.me", "m.facebook.com"], "facebook"],
  [["youtube.com", "youtu.be"], "youtube"],
  [["reddit.com", "redd.it"], "reddit"],
  [["tiktok.com"], "tiktok"],
  [["threads.net", "threads.com"], "threads"],
  [["pinterest.com", "pin.it"], "pinterest"],
  [["linkedin.com", "lnkd.in"], "linkedin"],
  [["github.com"], "github"],
];

/** Tracking params stripped from any host (plan: strip utm_* + common trackers). */
const GENERIC_TRACKING_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "utm_name",
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "igsh",
  "igshid",
  "si",
  "mkt_tok",
  "mc_cid",
  "mc_eid",
  "ref_src",
  "ref_url",
  "_hsenc",
  "_hsmi",
];

/** Tracking params that only make sense for a specific host. */
const HOST_TRACKING_PARAMS: Record<string, string[]> = {
  "x.com": ["s", "t", "cn"],
  "twitter.com": ["s", "t", "cn"],
  "youtube.com": ["feature", "pp"],
  "youtu.be": ["feature", "pp"],
  "instagram.com": ["img_index", "story_media_id", "hl"],
  "reddit.com": ["share_id", "context"],
};

export function detectPlatform(url: string | null): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    for (const [hosts, name] of PLATFORM_MAP) {
      if (hosts.includes(host)) return name;
    }
    return host;
  } catch {
    return null;
  }
}

/**
 * Normalize a URL for deduplication: lowercase scheme/host, drop default
 * port, drop fragment, strip tracking params. Returns null when the input
 * is not a parsable URL.
 */
export function normalizeUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (!/^https?:$/.test(url.protocol)) return null;
    if (!url.hostname.includes(".")) return null;

    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    for (const key of [...url.searchParams.keys()]) {
      const lk = key.toLowerCase();
      if (
        GENERIC_TRACKING_PARAMS.includes(lk) ||
        (HOST_TRACKING_PARAMS[host] ?? []).includes(lk)
      ) {
        url.searchParams.delete(key);
      }
    }
    url.hash = "";
    url.protocol = url.protocol.toLowerCase();
    url.hostname = host;

    const search = url.searchParams.toString();
    let normalized = `${url.protocol}//${host}${url.pathname}`;
    if (search) normalized += `?${search}`;
    return normalized;
  } catch {
    return null;
  }
}

const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/i;

export type ShareInput = {
  webUrl?: string | null;
  text?: string | null;
  title?: string | null;
};

export type AddResult = {
  item: VaultItem;
  duplicate: boolean;
};

/** Parse a share payload (url and/or text) into a vault item. */
export function parseShareInput(input: ShareInput): {
  kind: "link" | "text";
  url: string | null;
  urlKey: string | null;
  title: string | null;
  rawText: string | null;
  platform: string | null;
} | null {
  const text = input.text?.trim() || null;
  let url = input.webUrl?.trim() || null;
  if (url) {
    const normalized = normalizeUrl(url);
    url = normalized ?? url;
  }
  if (!url && text) {
    const match = text.match(URL_REGEX);
    if (match) url = match[0].replace(/[.,;:!?)\]]+$/, "");
  }
  if (!url && !text) return null;

  if (url) {
    // rawText only carries signal when it says more than the URL itself
    const caption = text && text !== url ? text : null;
    const raw = caption;
    return {
      kind: "link",
      url,
      urlKey: normalizeUrl(url) ?? url,
      title: input.title?.trim() || null,
      rawText: raw,
      platform: detectPlatform(url),
    };
  }
  return {
    kind: "text",
    url: null,
    urlKey: null,
    title: null,
    rawText: text,
    platform: null,
  };
}

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function loadItems(): Promise<VaultItem[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // backfill fields added after v1 of the storage format
    return parsed.map((item: Partial<VaultItem>) => ({
      description: null,
      thumbnailUrl: null,
      siteName: null,
      meta: null,
      enrichmentLevel: null,
      enrichedAt: null,
      enrichAttempts: 0,
      favorite: false,
      serverId: null,
      syncedAt: null,
      serverStatus: null,
      categoryId: null,
      categoryName: null,
      ...item,
    })) as VaultItem[];
  } catch {
    return [];
  }
}

/** Persist a full list — also used by the sync engine outside useVault. */
export async function saveItems(items: VaultItem[]): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // storage full/unavailable — keep the in-memory list usable
  }
}

export function sortItems(items: VaultItem[]): VaultItem[] {
  return [...items].sort(
    (a, b) =>
      new Date(b.lastSeenAt || b.createdAt).getTime() -
      new Date(a.lastSeenAt || a.createdAt).getTime()
  );
}

export function saveShareInput(
  existing: VaultItem[],
  input: ShareInput
): { items: VaultItem[]; result: AddResult | null } {
  const parsed = parseShareInput(input);
  if (!parsed) return { items: existing, result: null };

  const now = new Date().toISOString();
  if (parsed.urlKey) {
    const idx = existing.findIndex((i) => i.urlKey === parsed.urlKey);
    if (idx !== -1) {
      const dupe = existing[idx];
      const merged: VaultItem = {
        ...dupe,
        seenCount: dupe.seenCount + 1,
        lastSeenAt: now,
        // fill in title/caption the first share didn't have
        title: dupe.title ?? parsed.title,
        rawText: dupe.rawText ?? parsed.rawText,
      };
      const items = [...existing];
      items[idx] = merged;
      return { items: sortItems(items), result: { item: merged, duplicate: true } };
    }
  }

  const item: VaultItem = {
    id: makeId(),
    ...parsed,
    description: null,
    thumbnailUrl: null,
    siteName: null,
    meta: null,
    enrichmentLevel: null,
    enrichedAt: null,
    enrichAttempts: 0,
    favorite: false,
    serverId: null,
    syncedAt: null,
    serverStatus: null,
    categoryId: null,
    categoryName: null,
    createdAt: now,
    lastSeenAt: now,
    seenCount: 1,
  };
  return { items: sortItems([item, ...existing]), result: { item, duplicate: false } };
}

export function removeItem(items: VaultItem[], id: string): VaultItem[] {
  return items.filter((i) => i.id !== id);
}

export function itemDisplayTitle(item: VaultItem): string {
  if (item.title) return item.title;
  const caption = item.rawText?.split("\n").find((l) => l.trim() && l.trim() !== item.url);
  if (caption) return caption.trim();
  if (item.url) {
    try {
      const u = new URL(item.url);
      const seg = u.pathname.split("/").filter(Boolean).pop();
      if (seg) return decodeURIComponent(seg.replace(/[-_]+/g, " ")).slice(0, 80);
      return u.hostname.replace(/^www\./, "");
    } catch {
      return item.url.slice(0, 80);
    }
  }
  return "Untitled note";
}

/** Just the host of an item's URL, or null for notes. */
export function domainOf(item: VaultItem): string | null {
  if (!item.url) return null;
  try {
    return new URL(item.url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Hook wiring the vault list to AsyncStorage. */
export function useVault() {
  const [items, setItems] = useState<VaultItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const itemsRef = useRef<VaultItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    loadItems().then((stored) => {
      if (cancelled) return;
      itemsRef.current = stored;
      setItems(stored);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const commit = useCallback((next: VaultItem[]) => {
    itemsRef.current = next;
    setItems(next);
    void saveItems(next);
  }, []);

  const add = useCallback(
    (input: ShareInput): AddResult | null => {
      const { items: next, result } = saveShareInput(itemsRef.current, input);
      if (result) commit(next);
      return result;
    },
    [commit]
  );

  const remove = useCallback(
    (id: string) => {
      commit(removeItem(itemsRef.current, id));
    },
    [commit]
  );

  /** Batch-patch items (enrichment results, favorites) in one persist. */
  const updateMany = useCallback(
    (patches: Array<{ id: string; patch: Partial<VaultItem> }>) => {
      if (patches.length === 0) return;
      const byId = new Map(patches.map((p) => [p.id, p.patch]));
      commit(
        itemsRef.current.map((item) => {
          const patch = byId.get(item.id);
          return patch ? { ...item, ...patch } : item;
        })
      );
    },
    [commit]
  );

  const toggleFavorite = useCallback(
    (id: string) => {
      commit(
        itemsRef.current.map((item) =>
          item.id === id ? { ...item, favorite: !item.favorite } : item
        )
      );
    },
    [commit]
  );

  /** Replace the whole list (sync engine results) and persist. */
  const applyAll = useCallback(
    (next: VaultItem[]) => {
      commit(next);
    },
    [commit]
  );

  /** Re-read from storage (e.g. after Settings ran a sync). */
  const reload = useCallback(async () => {
    const stored = await loadItems();
    itemsRef.current = stored;
    setItems(stored);
  }, []);

  return { items, loaded, add, remove, updateMany, toggleFavorite, applyAll, reload, itemsRef };
}
