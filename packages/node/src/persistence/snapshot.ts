import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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

export type DurableWriteHooks = {
  afterWrite?: () => void;
  afterFileFsync?: () => void;
  afterRename?: () => void;
  afterDirFsync?: () => void;
};

// Crash-safe write-and-replace sequence:
//   1. Write data to a sibling tmp file.
//   2. fsync the tmp file's fd so its bytes are durable before the rename.
//   3. rename() the tmp file over the target (atomic on POSIX).
//   4. fsync the containing directory so the directory entry update is durable.
//
// Without steps 2 and 4 a crash between write and directory-entry sync can
// leave the rename not recorded — reader sees the old file, not the new one.
// Implemented once here and reused by anything needing crash-safe overwrites.
//
// Hooks exist so tests can assert ordering without ESM spies (which Node
// disallows on the `node:fs` namespace).
export function durableWriteAndRename(
  filePath: string,
  data: string,
  hooks: DurableWriteHooks = {}
): void {
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, data);
  hooks.afterWrite?.();

  // fsync the tmp file's contents.
  const tmpFd = openSync(tmpPath, "r+");
  try {
    fsyncSync(tmpFd);
  } finally {
    closeSync(tmpFd);
  }
  hooks.afterFileFsync?.();

  renameSync(tmpPath, filePath);
  hooks.afterRename?.();

  // fsync the directory so the rename's directory entry is durable.
  // On Windows, fsync on a directory fd commonly throws EPERM; the rename
  // itself is still the durable unit on NTFS, so swallow that specific error.
  const dirFd = openSync(dirname(filePath), "r");
  try {
    try {
      fsyncSync(dirFd);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EINVAL") throw error;
    }
  } finally {
    closeSync(dirFd);
  }
  hooks.afterDirFsync?.();
}

export function writeSnapshotAtomic(filePath: string, entries: SnapshotEntry[]): void {
  durableWriteAndRename(filePath, JSON.stringify(entries));
}
