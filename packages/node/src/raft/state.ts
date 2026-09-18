import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface RaftPersistentState {
  currentTerm: number;
  votedFor: string | null;
}

export function loadRaftState(filePath: string): RaftPersistentState {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<RaftPersistentState>;
    if (typeof parsed.currentTerm === "number" && (parsed.votedFor === null || typeof parsed.votedFor === "string")) {
      return { currentTerm: parsed.currentTerm, votedFor: parsed.votedFor };
    }
  } catch {
    // A missing or incomplete state file starts from the safe defaults.
  }
  return { currentTerm: 0, votedFor: null };
}

export function persistRaftState(filePath: string, state: RaftPersistentState): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(state)}\n`, "utf8");
  const fd = openSync(tempPath, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tempPath, filePath);
}