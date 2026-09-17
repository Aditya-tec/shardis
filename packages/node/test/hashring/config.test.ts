import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadClusterConfig } from "../../src/hashring/config.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "shardis-cluster-config-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadClusterConfig", () => {
  it("parses a valid cluster config file", () => {
    const filePath = join(dir, "cluster.json");
    const config = {
      shards: [{ id: "shard-a", hash_range: [0, 16383], leader: { id: "n1", url: "ws://n1/ws" }, followers: [] }]
    };
    writeFileSync(filePath, JSON.stringify(config));

    expect(loadClusterConfig(filePath)).toEqual(config);
  });

  it("throws if the file does not exist", () => {
    expect(() => loadClusterConfig(join(dir, "missing.json"))).toThrow();
  });
});
