import type { VaultItem } from "./store";

/**
 * Folder model, two ways to slice the vault (user choice on Home):
 *  - "platform"  — one folder per platform (X, Instagram, YouTube…)
 *  - "category"  — one folder per AI category (`cat:<name>` keys) plus an
 *                  Uncategorized folder; real categories arrive with the
 *                  backend AI layer, until then it groups uncategorized items
 * Starred / Notes exist in both modes.
 */
export type FolderMode = "platform" | "category";

const CAT_PREFIX = "cat:";
const CAT_NONE = "cat:_none";

export const FOLDER_LABELS: Record<string, string> = {
  all: "All",
  starred: "Starred",
  note: "Notes",
  x: "X",
  instagram: "Instagram",
  facebook: "Facebook",
  youtube: "YouTube",
  reddit: "Reddit",
  tiktok: "TikTok",
  threads: "Threads",
  pinterest: "Pinterest",
  linkedin: "LinkedIn",
  github: "GitHub",
  link: "Links",
};

export function folderLabel(key: string): string {
  if (key.startsWith(CAT_PREFIX)) {
    const name = key.slice(CAT_PREFIX.length);
    return name === "_none" ? "Uncategorized" : name;
  }
  return FOLDER_LABELS[key] ?? key;
}

export type Folder = { key: string; items: VaultItem[] };

export function itemsInFolder(items: VaultItem[], key: string): VaultItem[] {
  if (key === "all") return items;
  if (key === "starred") return items.filter((i) => i.favorite);
  if (key === "note") return items.filter((i) => i.kind === "text");
  if (key.startsWith(CAT_PREFIX)) {
    if (key === CAT_NONE) return items.filter((i) => !i.categoryName);
    const name = key.slice(CAT_PREFIX.length);
    return items.filter((i) => i.categoryName === name);
  }
  return items.filter((i) => i.kind === "link" && (i.platform ?? "link") === key);
}

/** All + one folder per group present + Starred + Notes. */
export function foldersFromItems(items: VaultItem[], mode: FolderMode = "platform"): Folder[] {
  const folders: Folder[] = [{ key: "all", items }];

  if (mode === "category") {
    const names: string[] = [];
    for (const i of items) {
      if (i.categoryName && !names.includes(i.categoryName)) names.push(i.categoryName);
    }
    names.sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      folders.push({ key: `${CAT_PREFIX}${name}`, items: itemsInFolder(items, `${CAT_PREFIX}${name}`) });
    }
    const uncategorized = items.filter((i) => !i.categoryName);
    if (uncategorized.length > 0) folders.push({ key: CAT_NONE, items: uncategorized });
  } else {
    const platforms: string[] = [];
    for (const i of items) {
      if (i.kind !== "link") continue;
      const p = i.platform ?? "link";
      if (!platforms.includes(p)) platforms.push(p);
    }
    for (const p of platforms) folders.push({ key: p, items: itemsInFolder(items, p) });
  }

  const starred = items.filter((i) => i.favorite);
  if (starred.length > 0) folders.push({ key: "starred", items: starred });
  const notes = items.filter((i) => i.kind === "text");
  if (notes.length > 0) folders.push({ key: "note", items: notes });
  return folders;
}
