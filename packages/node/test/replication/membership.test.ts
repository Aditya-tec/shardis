import { describe, expect, it } from "vitest";
import { ReplicationManager } from "../../src/replication/manager.js";

class FakeSocket {
  readyState = 1;
  sent: string[] = [];
  private readonly listeners = new Map<string, (...args: unknown[]) => void>();

  on(event: string, listener: (...args: unknown[]) => void): this {
    this.listeners.set(event, listener);
    return this;
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.listeners.get("close")?.();
  }

  removeAllListeners(): this {
    this.listeners.clear();
    return this;
  }
}

function manager(connect: (socket: FakeSocket) => FakeSocket): ReplicationManager {
  return new ReplicationManager({
    nodeId: "node-a1",
    shardId: "shard-a",
    peers: [{ id: "node-a2", url: "ws://a2/ws" }],
    initialLeaderId: "node-a1",
    heartbeatIntervalMs: 1000,
    heartbeatTimeoutMs: 3000,
    store: {} as never,
    aofLog: {} as never,
    log: () => undefined,
    connect: () => connect(new FakeSocket()) as never,
    nodeUrl: "ws://a1/ws"
  });
}

describe("dynamic replication membership", () => {
  it("adds a joined follower and relays an announcement to connected peers", () => {
    const connected: FakeSocket[] = [];
    const replication = manager((socket) => {
      connected.push(socket);
      return socket;
    });
    replication.start();
    const inbound = new FakeSocket();

    expect(
      replication.handleInboundRaw(
        inbound as never,
        JSON.stringify({ type: "MEMBER_JOIN", nodeId: "node-a3", shardId: "shard-a", url: "ws://a3/ws" })
      )
    ).toBe(true);
    expect(replication.getConnectedPeerIds()).toContain("node-a3");
    expect(connected.some((socket) => socket.sent.some((payload) => payload.includes("MEMBER_ANNOUNCE")))).toBe(true);
    replication.stop();
  });

  it("removes a member and relays the leave message", () => {
    const connected: FakeSocket[] = [];
    const replication = manager((socket) => {
      connected.push(socket);
      return socket;
    });
    replication.start();
    replication.handleInboundRaw(
      new FakeSocket() as never,
      JSON.stringify({ type: "MEMBER_JOIN", nodeId: "node-a3", shardId: "shard-a", url: "ws://a3/ws" })
    );
    const source = new FakeSocket();
    expect(
      replication.handleInboundRaw(source as never, JSON.stringify({ type: "MEMBER_LEAVE", nodeId: "node-a3", shardId: "shard-a" }))
    ).toBe(true);
    expect(replication.getConnectedPeerIds()).not.toContain("node-a3");
    expect(connected.some((socket) => socket.sent.some((payload) => payload.includes("MEMBER_LEAVE")))).toBe(true);
    replication.stop();
  });
});