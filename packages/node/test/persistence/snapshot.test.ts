import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSnapshot, writeSnapshotAtomic } from "../../src/persistence/snapshot.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "shardis-snapshot-unit-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("snapshot", () => {
  it("loadSnapshot returns null when the file does not exist", () => {
    expect(loadSnapshot(join(dir, "missing.json"))).toBeNull();
  });

  it("round-trips entries through writeSnapshotAtomic and loadSnapshot", () => {
    const filePath = join(dir, "snapshot.json");
    const entries = [
      { key: "a", value: "1", expiresAt: null },
      { key: "b", value: "2", expiresAt: 123456 }
    ];
    writeSnapshotAtomic(filePath, entries);
    expect(loadSnapshot(filePath)).toEqual(entries);
  });

  it("writeSnapshotAtomic leaves no .tmp file behind and overwrites an existing snapshot", () => {
    const filePath = join(dir, "snapshot.json");
    writeSnapshotAtomic(filePath, [{ key: "old", value: "1", expiresAt: null }]);
    writeSnapshotAtomic(filePath, [{ key: "new", value: "2", expiresAt: null }]);

    expect(existsSync(`${filePath}.tmp`)).toBe(false);
    expect(loadSnapshot(filePath)).toEqual([{ key: "new", value: "2", expiresAt: null }]);
  });

  it("treats an empty file as no snapshot rather than throwing on JSON.parse", () => {
    const filePath = join(dir, "snapshot.json");
    writeFileSync(filePath, "");
    expect(loadSnapshot(filePath)).toBeNull();
  });
});
