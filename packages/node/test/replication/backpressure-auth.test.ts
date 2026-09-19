import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type WebSocket from "ws";
import { Store } from "../../src/engine/store.js";
import { AofLog } from "../../src/persistence/aof.js";
import {
  REPL_BACKPRESSURE_THRESHOLD_BYTES,
  ReplicationManager
} from "../../src/replication/manager.js";

class FakeSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  closedWith: { code?: number; reason?: string } | null = null;
  readonly sent: unknown[] = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
    this.readyState = 3;
  }
}

describe("ReplicationManager peer auth + backpressure", () => {
  let dataDir: string;
  let aof: AofLog;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "shardis-repl-unit-"));
    aof = new AofLog(join(dataDir, "aof.log"));
    aof.open();
  });

  afterEach(() => {
    aof.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("rejects PEER_HELLO without a valid CLUSTER_SECRET and logs peer_auth_rejected", () => {
    const events: string[] = [];
    const manager = new ReplicationManager({
      nodeId: "node-a1",
      shardId: "shard-a",
      peers: [{ id: "node-a2", url: "ws://a2/ws" }],
      initialLeaderId: "node-a1",
      heartbeatIntervalMs: 1000,
      heartbeatTimeoutMs: 3000,
      store: new Store(),
      aofLog: aof,
      clusterSecret: "s3cret",
      log: (event) => events.push(event),
      connect: () => new FakeSocket() as unknown as WebSocket
    });

    const inbound = new FakeSocket();
    manager.handleInboundRaw(
      inbound as unknown as WebSocket,
      JSON.stringify({ type: "PEER_HELLO", nodeId: "node-a2", shardId: "shard-a", clusterSecret: "nope" })
    );

    expect(events).toContain("peer_auth_rejected");
    expect(inbound.closedWith?.code).toBe(1008);
    expect(manager.getConnectedPeerIds()).not.toContain("node-a2");
  });

  it("marks a follower lagging and skips sends once bufferedAmount hits the soft threshold", () => {
    const events: string[] = [];
    const peerSocket = new FakeSocket();
    peerSocket.bufferedAmount = REPL_BACKPRESSURE_THRESHOLD_BYTES;

    const manager = new ReplicationManager({
      nodeId: "node-a1",
      shardId: "shard-a",
      peers: [{ id: "node-a2", url: "ws://a2/ws" }],
      initialLeaderId: "node-a1",
      heartbeatIntervalMs: 1000,
      heartbeatTimeoutMs: 3000,
      store: new Store(),
      aofLog: aof,
      log: (event) => events.push(event),
      connect: () => peerSocket as unknown as WebSocket
    });

    manager.start();
    // Simulate inbound peer registration so the connection is tracked.
    manager.handleInboundRaw(
      peerSocket as unknown as WebSocket,
      JSON.stringify({ type: "PEER_HELLO", nodeId: "node-a2", shardId: "shard-a" })
    );

    // Outbound connect wins over inbound when outbound:true already exists;
    // force the connection map onto our fake socket with lagging=false.
    (manager as unknown as { connections: Map<string, { socket: FakeSocket; lagging: boolean; outbound: boolean; lastHeartbeatAt: number; url: string }> })
      .connections.set("node-a2", {
        socket: peerSocket,
        url: "ws://a2/ws",
        lastHeartbeatAt: Date.now(),
        outbound: true,
        lagging: false
      });

    const before = peerSocket.sent.length;
    manager.afterLocalWrite({ op: "SET", key: "k", value: "v", expiresAt: null });

    expect(events).toContain("replication_lagging");
    expect(manager.getPerFollowerLagging()["node-a2"]).toBe(true);
    // No new REPL_OP should have been sent while lagging.
    const replOps = peerSocket.sent.slice(before).filter(
      (m): m is { type: string } => typeof m === "object" && m !== null && (m as { type?: string }).type === "REPL_OP"
    );
    expect(replOps).toHaveLength(0);

    manager.stop();
  });

  it("exposes null per-follower lag until the first REPL_ACK arrives", () => {
    const peerSocket = new FakeSocket();
    const manager = new ReplicationManager({
      nodeId: "node-a1",
      shardId: "shard-a",
      peers: [{ id: "node-a2", url: "ws://a2/ws" }],
      initialLeaderId: "node-a1",
      heartbeatIntervalMs: 1000,
      heartbeatTimeoutMs: 3000,
      store: new Store(),
      aofLog: aof,
      log: () => undefined,
      connect: () => peerSocket as unknown as WebSocket,
      now: () => 10_000
    });

    (manager as unknown as { connections: Map<string, unknown> }).connections.set("node-a2", {
      socket: peerSocket,
      url: "ws://a2/ws",
      lastHeartbeatAt: 10_000,
      outbound: true,
      lagging: false
    });

    expect(manager.getPerFollowerLagMs()).toEqual({ "node-a2": null });

    manager.handleInboundRaw(
      peerSocket as unknown as WebSocket,
      JSON.stringify({ type: "REPL_ACK", nodeId: "node-a2", leaderId: "node-a1", seq: 1 })
    );
    expect(manager.getPerFollowerLagMs()).toEqual({ "node-a2": 0 });

    manager.stop();
  });
});
