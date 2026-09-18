import { describe, expect, it } from "vitest";
import { tryParseClusterGossipMessage } from "../../src/gossip/protocol.js";

describe("cluster gossip protocol", () => {
  it("parses a leader announcement", () => {
    expect(
      tryParseClusterGossipMessage(
        JSON.stringify({ type: "SHARD_LEADER_ANNOUNCE", shardId: "shard-a", leaderId: "node-a2", leaderUrl: "ws://a2/ws" })
      )
    ).toEqual({ type: "SHARD_LEADER_ANNOUNCE", shardId: "shard-a", leaderId: "node-a2", leaderUrl: "ws://a2/ws" });
  });

  it("rejects malformed or unrelated messages", () => {
    expect(tryParseClusterGossipMessage("not-json")).toBeNull();
    expect(tryParseClusterGossipMessage(JSON.stringify({ type: "HEARTBEAT" }))).toBeNull();
    expect(
      tryParseClusterGossipMessage(JSON.stringify({ type: "SHARD_LEADER_ANNOUNCE", shardId: "shard-a", leaderId: "unknown" }))
    ).toBeNull();
  });
});