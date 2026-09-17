import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AofLog } from "../../src/persistence/aof.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "shardis-aof-unit-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("AofLog", () => {
  it("creates the data directory and file on open", () => {
    const log = new AofLog(join(dir, "nested", "aof.log"));
    log.open();
    expect(existsSync(join(dir, "nested", "aof.log"))).toBe(true);
    log.close();
  });

  it("appends entries as newline-delimited JSON", () => {
    const filePath = join(dir, "aof.log");
    const log = new AofLog(filePath);
    log.open();
    log.append({ op: "SET", key: "foo", value: "bar", expiresAt: null });
    log.append({ op: "DEL", key: "foo" });
    log.close();

    const lines = readFileSync(filePath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ op: "SET", key: "foo", value: "bar", expiresAt: null });
    expect(JSON.parse(lines[1])).toEqual({ op: "DEL", key: "foo" });
  });

  it("replay returns [] for a file that does not exist yet", () => {
    const log = new AofLog(join(dir, "missing.log"));
    expect(log.replay()).toEqual([]);
  });

  it("replay round-trips entries written in a prior open() session", () => {
    const filePath = join(dir, "aof.log");
    const first = new AofLog(filePath);
    first.open();
    first.append({ op: "SET", key: "a", value: "1", expiresAt: null });
    first.append({ op: "SET", key: "b", value: "2", expiresAt: 12345 });
    first.close();

    const second = new AofLog(filePath);
    expect(second.replay()).toEqual([
      { op: "SET", key: "a", value: "1", expiresAt: null },
      { op: "SET", key: "b", value: "2", expiresAt: 12345 }
    ]);
  });

  it("replay stops at a truncated final line instead of discarding everything before it", () => {
    const filePath = join(dir, "aof.log");
    const good = JSON.stringify({ op: "SET", key: "a", value: "1", expiresAt: null });
    // Simulates a crash mid-write: a complete first entry followed by a
    // partially flushed second one with no trailing newline.
    writeFileSync(filePath, `${good}\n{"op":"SET","key":"b","valu`);

    const log = new AofLog(filePath);
    expect(log.replay()).toEqual([{ op: "SET", key: "a", value: "1", expiresAt: null }]);
  });

  it("append throws if the log was never opened", () => {
    const log = new AofLog(join(dir, "aof.log"));
    expect(() => log.append({ op: "DEL", key: "foo" })).toThrow(/not open/);
  });
});
