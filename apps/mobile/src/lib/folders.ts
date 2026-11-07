import type { VaultItem } from "./store";

/**
 * Platform folders — "every folder is a platform". Derived entirely from the
 * vault contents: a folder exists when at least one item belongs to it.
 */
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
  return FOLDER_LABELS[key] ?? key;
}

export type Folder = { key: string; items: VaultItem[] };

export function itemsInFolder(items: VaultItem[], key: string): VaultItem[] {
  if (key === "all") return items;
  if (key === "starred") return items.filter((i) => i.favorite);
  if (key === "note") return items.filter((i) => i.kind === "text");
  return items.filter((i) => i.kind === "link" && (i.platform ?? "link") === key);
}

/** All + one folder per platform present + Starred + Notes. */
export function foldersFromItems(items: VaultItem[]): Folder[] {
  const platforms: string[] = [];
  for (const i of items) {
    if (i.kind !== "link") continue;
    const p = i.platform ?? "link";
    if (!platforms.includes(p)) platforms.push(p);
  }
  const folders: Folder[] = [{ key: "all", items }];
  for (const p of platforms) folders.push({ key: p, items: itemsInFolder(items, p) });
  const starred = items.filter((i) => i.favorite);
  if (starred.length > 0) folders.push({ key: "starred", items: starred });
  const notes = items.filter((i) => i.kind === "text");
  if (notes.length > 0) folders.push({ key: "note", items: notes });
  return folders;
}
