import type { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import { ClusterGossip } from "../../src/gossip/clusterGossip.js";

const shards = [
  {
    id: "shard-a",
    hash_range: [0, 8191] as [number, number],
    leader: { id: "node-a1", url: "ws://a1/ws" },
    followers: [{ id: "node-a2", url: "ws://a2/ws" }]
  },
  {
    id: "shard-b",
    hash_range: [8192, 16383] as [number, number],
    leader: { id: "node-b1", url: "ws://b1/ws" },
    followers: [{ id: "node-b2", url: "ws://b2/ws" }]
  }
];

function gossip(nodeId = "node-b1"): ClusterGossip {
  return new ClusterGossip({ nodeId, shards, heartbeatIntervalMs: 100, log: () => undefined, connect: () => { throw new Error("not used"); } });
}

describe("ClusterGossip", () => {
  it("seeds static leaders and updates a known shard from an announcement", () => {
    const instance = gossip();
    expect(instance.getCurrentLeaderUrl("shard-a")).toBe("ws://a1/ws");

    const socket = {} as WebSocket;
    expect(
      instance.handleInboundRaw(
        socket,
        JSON.stringify({ type: "SHARD_LEADER_ANNOUNCE", shardId: "shard-a", leaderId: "node-a2", leaderUrl: "ws://a2/ws" })
      )
    ).toBe(true);
    expect(instance.getCurrentLeaderUrl("shard-a")).toBe("ws://a2/ws");
  });

  it("ignores unknown leaders and preserves the static fallback", () => {
    const instance = gossip();
    expect(
      instance.handleInboundRaw(
        {} as WebSocket,
        JSON.stringify({ type: "SHARD_LEADER_ANNOUNCE", shardId: "shard-a", leaderId: "intruder", leaderUrl: "ws://bad/ws" })
      )
        ).toBe(true);
    expect(instance.getCurrentLeaderUrl("shard-a")).toBe("ws://a1/ws");
    expect(instance.getCurrentLeaderUrl("missing")).toBeUndefined();
  });

  it("announces a new own-shard leader using the configured node URL", () => {
    const instance = gossip("node-a1");
    instance.announceOwnShardLeader("shard-a", "node-a2");
    expect(instance.getCurrentLeaderUrl("shard-a")).toBe("ws://a2/ws");
  });
});