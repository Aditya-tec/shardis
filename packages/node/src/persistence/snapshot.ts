import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export interface SnapshotEntry {
  key: string;
  value: string;
  expiresAt: number | null;
}

export function loadSnapshot(filePath: string): SnapshotEntry[] | null {
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, "utf8");
  if (content.trim().length === 0) return null;
  return JSON.parse(content) as SnapshotEntry[];
}

// Writes to a sibling temp file then renames over the target, so a reader
// (or a crash mid-write) never observes a partially written snapshot.
export function writeSnapshotAtomic(filePath: string, entries: SnapshotEntry[]): void {
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(entries));
  renameSync(tmpPath, filePath);
}
