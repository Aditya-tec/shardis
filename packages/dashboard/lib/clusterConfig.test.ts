import { describe, expect, it } from "vitest";
import { DEFAULT_NODES, DEFAULT_SHARDS, HASH_SLOT_COUNT, parseEnvJson } from "./clusterConfig";

describe("parseEnvJson", () => {
  it("returns null for undefined (no override configured)", () => {
    expect(parseEnvJson(undefined)).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(parseEnvJson("")).toBeNull();
  });

  it("returns null for invalid JSON instead of throwing", () => {
    expect(parseEnvJson("{not valid json")).toBeNull();
  });

  it("parses valid JSON", () => {
    expect(parseEnvJson<{ a: number }>('{"a": 1}')).toEqual({ a: 1 });
  });

  it("parses a valid node-descriptor array shape", () => {
    const raw = JSON.stringify([{ id: "n1", shard: "shard-a", httpUrl: "http://x", wsUrl: "ws://x/ws" }]);
    expect(parseEnvJson(raw)).toEqual([{ id: "n1", shard: "shard-a", httpUrl: "http://x", wsUrl: "ws://x/ws" }]);
  });
});

describe("defaults", () => {
  it("DEFAULT_NODES covers all 6 local Compose nodes with matching shard ids", () => {
    expect(DEFAULT_NODES).toHaveLength(6);
    const ids = DEFAULT_NODES.map((n) => n.id);
    expect(ids).toEqual(["node-a1", "node-a2", "node-b1", "node-b2", "node-c1", "node-c2"]);
  });

  it("DEFAULT_SHARDS hash ranges exactly cover [0, HASH_SLOT_COUNT) with no gaps or overlaps", () => {
    const sorted = [...DEFAULT_SHARDS].sort((a, b) => a.hashRange[0] - b.hashRange[0]);
    expect(sorted[0].hashRange[0]).toBe(0);
    expect(sorted[sorted.length - 1].hashRange[1]).toBe(HASH_SLOT_COUNT - 1);
    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i].hashRange[0]).toBe(sorted[i - 1].hashRange[1] + 1);
    }
  });

  it("every shard's nodeIds reference actual entries in DEFAULT_NODES", () => {
    const nodeIds = new Set(DEFAULT_NODES.map((n) => n.id));
    for (const shard of DEFAULT_SHARDS) {
      for (const id of shard.nodeIds) {
        expect(nodeIds.has(id)).toBe(true);
      }
    }
  });
});
