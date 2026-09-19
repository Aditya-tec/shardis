import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { durableWriteAndRename, loadSnapshot, writeSnapshotAtomic } from "../../src/persistence/snapshot.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "shardis-snapshot-unit-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("durableWriteAndRename", () => {
  it("writes the correct content to the target path", () => {
    const target = join(dir, "out.json");
    durableWriteAndRename(target, '{"ok":true}');
    expect(readFileSync(target, "utf8")).toBe('{"ok":true}');
  });

  it("leaves no .tmp sibling after a successful write", () => {
    const target = join(dir, "out.json");
    durableWriteAndRename(target, "data");
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });

  it("overwrites an existing target atomically (second call wins)", () => {
    const target = join(dir, "out.json");
    durableWriteAndRename(target, "first");
    durableWriteAndRename(target, "second");
    expect(readFileSync(target, "utf8")).toBe("second");
  });

  // Verify the required ordering: write → fsync file → rename → fsync dir.
  // Full fault-injection (simulating mid-sequence crash) is not implemented
  // here per the spec's guidance; hooks assert the call sequence without
  // ESM spies (Node disallows spying on the node:fs namespace).
  it("runs hooks in write → file-fsync → rename → dir-fsync order", () => {
    const calls: string[] = [];
    durableWriteAndRename(join(dir, "ordered.json"), "test", {
      afterWrite: () => calls.push("write"),
      afterFileFsync: () => calls.push("fileFsync"),
      afterRename: () => calls.push("rename"),
      afterDirFsync: () => calls.push("dirFsync")
    });
    expect(calls).toEqual(["write", "fileFsync", "rename", "dirFsync"]);
  });
});

describe("writeSnapshotAtomic", () => {
  it("round-trips entries through durableWriteAndRename and back via loadSnapshot", () => {
    const path = join(dir, "snapshot.json");
    const entries = [
      { key: "a", value: "1", expiresAt: null },
      { key: "b", value: "2", expiresAt: 999999 }
    ];
    writeSnapshotAtomic(path, entries);
    expect(loadSnapshot(path)).toEqual(entries);
  });
});
