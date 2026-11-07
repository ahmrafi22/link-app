import { File, Paths } from "expo-file-system";
import { Platform } from "react-native";

/**
 * Bridge to the native silent share target (plugins/with-android-share-target.js).
 * ReceiverActivity appends one JSON line per share to files/linkvault/inbox.jsonl;
 * the app drains (reads + deletes) that file when it is opened or foregrounded,
 * so sharing never has to open the app.
 */
export type InboxEntry = {
  text: string;
  subject: string;
  title: string;
  receivedAt: number;
};

export async function drainInbox(): Promise<InboxEntry[]> {
  if (Platform.OS !== "android") return [];
  let file: File;
  try {
    file = new File(Paths.document, "linkvault", "inbox.jsonl");
  } catch {
    return [];
  }
  if (!file.exists) return [];

  let raw = "";
  try {
    raw = await file.text();
  } catch {
    return [];
  }
  try {
    file.delete();
  } catch {
    // if the delete fails we would double-import next time; keep going anyway
  }

  const entries: InboxEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const e = JSON.parse(trimmed) as Partial<InboxEntry>;
      entries.push({
        text: typeof e.text === "string" ? e.text : "",
        subject: typeof e.subject === "string" ? e.subject : "",
        title: typeof e.title === "string" ? e.title : "",
        receivedAt: typeof e.receivedAt === "number" ? e.receivedAt : Date.now(),
      });
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}

/** Flatten an entry into the ShareInput shape the vault parser understands. */
export function inboxEntryToShareInput(e: InboxEntry): {
  webUrl: string | null;
  text: string | null;
  title: string | null;
} {
  const blob = [e.title, e.subject, e.text]
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n");
  return {
    webUrl: null,
    text: blob || null,
    // keep the title for display; the URL is extracted from the text blob
    title: e.title.trim() || null,
  };
}
