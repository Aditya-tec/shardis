import { describe, expect, it } from "vitest";
import type { ClusterConfig } from "../../src/hashring/config.js";
import { HashRing } from "../../src/hashring/ring.js";

const twoShardConfig: ClusterConfig = {
  shards: [
    { id: "shard-a", hash_range: [0, 8191], leader: { id: "node-a1", url: "ws://leader-a/ws" }, followers: [] },
    { id: "shard-b", hash_range: [8192, 16383], leader: { id: "node-b1", url: "ws://leader-b/ws" }, followers: [] }
  ]
};

describe("HashRing", () => {
  it("shardForSlot returns the shard owning that exact slot, at both range boundaries", () => {
    const ring = new HashRing(twoShardConfig);
    expect(ring.shardForSlot(0).id).toBe("shard-a");
    expect(ring.shardForSlot(8191).id).toBe("shard-a");
    expect(ring.shardForSlot(8192).id).toBe("shard-b");
    expect(ring.shardForSlot(16383).id).toBe("shard-b");
  });

  it("throws a clear error for a slot no configured shard owns", () => {
    const ring = new HashRing({
      shards: [{ id: "shard-a", hash_range: [0, 100], leader: { id: "n1", url: "ws://n1/ws" }, followers: [] }]
    });
    expect(() => ring.shardForSlot(200)).toThrow(/no shard owns hash slot 200/);
  });

  it("shardForKey routes a key to whichever shard's range contains its slot", () => {
    const ring = new HashRing(twoShardConfig);
    const shard = ring.shardForKey("some-test-key");
    expect(["shard-a", "shard-b"]).toContain(shard.id);
  });

  it("shardForKey is consistent with keySlot + shardForSlot for the same key", async () => {
    const { keySlot } = await import("../../src/hashring/hash.js");
    const ring = new HashRing(twoShardConfig);
    const key = "consistency-check-key";
    expect(ring.shardForKey(key)).toBe(ring.shardForSlot(keySlot(key)));
  });

  it("keys sharing a hash tag always route to the same shard", () => {
    const ring = new HashRing(twoShardConfig);
    const a = ring.shardForKey("user:{42}:profile");
    const b = ring.shardForKey("user:{42}:orders");
    expect(a.id).toBe(b.id);
  });
});
