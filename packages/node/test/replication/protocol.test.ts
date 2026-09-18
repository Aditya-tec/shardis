import { describe, expect, it } from "vitest";
import { tryParsePeerMessage } from "../../src/replication/protocol.js";

describe("tryParsePeerMessage", () => {
  it("parses each known peer message type", () => {
    expect(tryParsePeerMessage(JSON.stringify({ type: "PEER_HELLO", nodeId: "n1", shardId: "shard-a" }))).toEqual({
      type: "PEER_HELLO",
      nodeId: "n1",
      shardId: "shard-a"
    });
    expect(tryParsePeerMessage(JSON.stringify({ type: "HEARTBEAT", nodeId: "n1", leaderId: "n1" }))).toEqual({
      type: "HEARTBEAT",
      nodeId: "n1",
      leaderId: "n1"
    });
    expect(
      tryParsePeerMessage(JSON.stringify({ type: "REPL_OP", leaderId: "n1", seq: 1, op: "SET", key: "k", value: "v" }))
    ).toMatchObject({ type: "REPL_OP", seq: 1 });
    expect(tryParsePeerMessage(JSON.stringify({ type: "REPL_ACK", nodeId: "n2", leaderId: "n1", seq: 1 }))).toEqual({
      type: "REPL_ACK",
      nodeId: "n2",
      leaderId: "n1",
      seq: 1
    });
    expect(tryParsePeerMessage(JSON.stringify({ type: "MEMBER_JOIN", nodeId: "n3", shardId: "shard-a", url: "ws://n3/ws" }))).toEqual({
      type: "MEMBER_JOIN",
      nodeId: "n3",
      shardId: "shard-a",
      url: "ws://n3/ws"
    });
    expect(tryParsePeerMessage(JSON.stringify({ type: "MEMBER_LEAVE", nodeId: "n3", shardId: "shard-a" }))).toEqual({
      type: "MEMBER_LEAVE",
      nodeId: "n3",
      shardId: "shard-a"
    });
  });

  it("returns null for a client request (has 'op'/'id', no 'type')", () => {
    expect(tryParsePeerMessage(JSON.stringify({ id: "1", op: "SET", key: "k", value: "v" }))).toBeNull();
  });

  it("returns null for an unrecognized type", () => {
    expect(tryParsePeerMessage(JSON.stringify({ type: "SOMETHING_ELSE" }))).toBeNull();
  });

  it("returns null for malformed JSON without throwing", () => {
    expect(tryParsePeerMessage("{not json")).toBeNull();
  });

  it("returns null for a non-object JSON value", () => {
    expect(tryParsePeerMessage("42")).toBeNull();
    expect(tryParsePeerMessage("null")).toBeNull();
  });
});
