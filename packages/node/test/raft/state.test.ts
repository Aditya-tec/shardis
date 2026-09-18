import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRaftState, persistRaftState } from "../../src/raft/state.js";

describe("Raft persistent state", () => {
  const directories: string[] = [];

  afterEach(() => {
    while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
  });

  it("round-trips term and vote state through the data directory", () => {
    const directory = mkdtempSync(join(tmpdir(), "shardis-raft-state-"));
    directories.push(directory);
    const path = join(directory, "raft-state.json");

    expect(loadRaftState(path)).toEqual({ currentTerm: 0, votedFor: null });
    persistRaftState(path, { currentTerm: 7, votedFor: "node-a2" });
    expect(loadRaftState(path)).toEqual({ currentTerm: 7, votedFor: "node-a2" });
  });

  it("falls back safely when the state file is invalid", () => {
    const directory = mkdtempSync(join(tmpdir(), "shardis-raft-state-"));
    directories.push(directory);
    const path = join(directory, "raft-state.json");
    persistRaftState(path, { currentTerm: 3, votedFor: null });
    rmSync(path);
    expect(loadRaftState(path)).toEqual({ currentTerm: 0, votedFor: null });
  });
});
