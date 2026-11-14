import AsyncStorage from "@react-native-async-storage/async-storage";

import {
  deleteCapture,
  getApiConfig,
  getCaptures,
  postCapture,
  type ApiItem,
} from "./api";
import { sortItems, type VaultItem } from "./store";

/**
 * Local-first sync (Phase ②). AsyncStorage stays the working cache; the
 * server becomes the durable store once Settings has a config:
 *
 *  - uploads: local items with no `serverId` POST to /api/captures — the
 *    server dedupes on url_hash, so retries are always safe;
 *  - pulls: GET /api/captures merges server rows in (server wins for
 *    enrichment content it has, local keeps id/favorite/local-only meta);
 *  - deletes: removing a synced item records a pending delete, which is
 *    replayed (DELETE /api/captures/:id) and then tombstoned so pulls
 *    never resurrect it.
 *
 * Failures leave state untouched — everything retries on the next
 * open/foreground/sync. Favorites stay device-local by design.
 */

const TOMBSTONE_KEY = "linkvault.tombstones.v1";
const PENDING_DELETE_KEY = "linkvault.pendingdeletes.v1";

type Tombstone = { serverId: string; at: string };

async function readJsonList<T>(key: string): Promise<T[]> {
  try {
    const raw = await AsyncStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

async function writeJsonList(key: string, value: unknown[]): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch {
    // best-effort
  }
}

/** Record that a (synced) item was deleted locally; called from delete flows. */
export async function noteItemDeleted(item: VaultItem): Promise<void> {
  if (!item.serverId) return;
  const pending = await readJsonList<string>(PENDING_DELETE_KEY);
  if (!pending.includes(item.serverId)) {
    pending.push(item.serverId);
    await writeJsonList(PENDING_DELETE_KEY, pending);
  }
}

const LEVEL_RANK: Record<string, number> = {
  full: 3,
  metadata: 2,
  url_only: 1,
};

function serverLevelRank(level: string): number {
  if (level === "full_device" || level === "full_server") return 3;
  if (level === "metadata") return 2;
  if (level === "url_only") return 1;
  return 0;
}

function toCapturePayload(item: VaultItem) {
  const hasExtraction = Boolean(item.title || item.description || item.thumbnailUrl);
  return {
    url: item.url ?? undefined,
    text: item.rawText ?? undefined,
    title: item.title ?? undefined,
    capturedAt: item.createdAt,
    clientExtracted: hasExtraction
      ? {
          title: item.title,
          description: item.description,
          image: item.thumbnailUrl,
          source: "device",
        }
      : undefined,
  };
}

/** Server row → a fresh local item (used when pulling unknown links). */
function itemFromApiItem(a: ApiItem): VaultItem {
  const now = new Date().toISOString();
  return {
    id: a.id,
    serverId: a.id,
    syncedAt: now,
    kind: a.kind === "text" ? "text" : "link",
    url: a.url,
    urlKey: a.url,
    title: a.title,
    rawText: a.raw_text,
    platform: a.platform,
    description: a.description,
    thumbnailUrl: a.thumbnail_url,
    siteName: null,
    meta: null,
    enrichmentLevel:
      serverLevelRank(a.enrichment_level) >= 3
        ? "full"
        : a.enrichment_level === "metadata"
          ? "metadata"
          : a.enrichment_level === "url_only"
            ? "url_only"
            : null,
    enrichedAt: null,
    enrichAttempts: 0,
    favorite: false,
    serverStatus: a.status ?? null,
    summary: a.summary ?? null,
    topics: Array.isArray(a.topics) ? a.topics : null,
    imageContext: a.image_context ?? null,
    categoryId: a.categories?.id ?? null,
    categoryName: a.categories?.name ?? null,
    createdAt: a.created_at,
    lastSeenAt: a.last_seen_at ?? a.created_at,
    seenCount: a.seen_count,
  };
}

/** Merge a server row into a matched local item — server wins for content
 * it has, local keeps identity, favorite and better enrichment. Also used
 * by the item-detail retry button to apply a fresh server row. */
export function mergeServerIntoLocal(local: VaultItem, a: ApiItem): VaultItem {
  const serverRank = serverLevelRank(a.enrichment_level);
  const localRank = local.enrichmentLevel ? (LEVEL_RANK[local.enrichmentLevel] ?? 0) : 0;
  const lastSeenCandidates = [local.lastSeenAt, a.last_seen_at ?? a.created_at]
    .filter(Boolean)
    .sort()
    .reverse();
  return {
    ...local,
    serverId: a.id,
    syncedAt: new Date().toISOString(),
    serverStatus: a.status ?? local.serverStatus,
    seenCount: Math.max(local.seenCount, a.seen_count),
    lastSeenAt: lastSeenCandidates[0] ?? local.lastSeenAt,
    title: a.title ?? local.title,
    rawText: local.rawText ?? a.raw_text,
    description: local.description ?? a.description,
    thumbnailUrl: local.thumbnailUrl ?? a.thumbnail_url,
    platform: local.platform ?? a.platform,
    categoryId: a.categories?.id ?? local.categoryId,
    categoryName: a.categories?.name ?? local.categoryName,
    summary: a.summary ?? local.summary,
    topics: Array.isArray(a.topics) && a.topics.length > 0 ? a.topics : local.topics,
    imageContext: a.image_context ?? local.imageContext,
    enrichmentLevel:
      localRank >= serverRank
        ? local.enrichmentLevel
        : serverRank >= 3
          ? "full"
          : serverRank === 2
            ? "metadata"
            : serverRank === 1
              ? "url_only"
              : local.enrichmentLevel,
  };
}

export type SyncResult =
  | { skipped: true; reason: "no-config" }
  | { next: VaultItem[]; uploaded: number; pulled: number; deleted: number; failed: number };

/**
 * Full sync round. Pure with respect to the list: takes the current items,
 * returns the next list — the caller decides how to commit it (useVault
 * passes itemsRef.current and applyAll; Settings saves via saveItems).
 */
export async function syncVault(current: VaultItem[]): Promise<SyncResult> {
  const config = await getApiConfig();
  if (!config) return { skipped: true, reason: "no-config" };

  // 1) replay pending deletes first, so a pull can't resurrect them
  let deleted = 0;
  const pending = await readJsonList<string>(PENDING_DELETE_KEY);
  const stillPending: string[] = [];
  for (const serverId of pending) {
    if (await deleteCapture(config, serverId)) {
      const tombs = await readJsonList<Tombstone>(TOMBSTONE_KEY);
      tombs.push({ serverId, at: new Date().toISOString() });
      await writeJsonList(TOMBSTONE_KEY, tombs);
      deleted += 1;
    } else {
      stillPending.push(serverId);
    }
  }
  if (pending.length > 0) await writeJsonList(PENDING_DELETE_KEY, stillPending);

  const now = new Date().toISOString();
  const uploadPatches = new Map<string, { serverId: string; syncedAt: string }>();

  // 2) upload the outbox — items that have never reached the server
  let failed = 0;
  for (const item of current) {
    if (item.serverId) continue;
    const r = await postCapture(config, toCapturePayload(item));
    if (r.ok) {
      uploadPatches.set(item.id, { serverId: r.id, syncedAt: now });
    } else {
      failed += 1;
    }
  }

  const working: VaultItem[] = current.map((item) => {
    const p = uploadPatches.get(item.id);
    return p ? { ...item, serverId: p.serverId, syncedAt: p.syncedAt } : item;
  });

  // 3) pull and merge
  let pulled = 0;
  const pull = await getCaptures(config, 200);
  if (pull.ok) {
    const tombs = await readJsonList<Tombstone>(TOMBSTONE_KEY);
    const gone = new Set<string>([...tombs.map((t) => t.serverId), ...stillPending]);
    const byServer = new Map<string, VaultItem>();
    const byUrl = new Map<string, VaultItem>();
    for (const item of working) {
      if (item.serverId) byServer.set(item.serverId, item);
      if (item.urlKey) byUrl.set(item.urlKey, item);
    }
    const matchedIds = new Set<string>();
    const imported: VaultItem[] = [];
    for (const a of pull.items) {
      if (gone.has(a.id)) continue;
      const existing = byServer.get(a.id) ?? (a.url ? byUrl.get(a.url) : undefined);
      if (existing) {
        matchedIds.add(existing.id);
        const merged = mergeServerIntoLocal(existing, a);
        // replace in byServer/byUrl so later rows can't double-match
        byServer.set(a.id, merged);
        if (merged.urlKey) byUrl.set(merged.urlKey, merged);
      } else {
        imported.push(itemFromApiItem(a));
        pulled += 1;
      }
    }
    const kept = working.filter((item) => !matchedIds.has(item.id));
    return { next: sortItems([...kept, ...imported]), uploaded: uploadPatches.size, pulled, deleted, failed };
  }

  // pull failed — uploads (if any) still landed; keep them
  return { next: working, uploaded: uploadPatches.size, pulled: 0, deleted, failed };
}
