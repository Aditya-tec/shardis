import WebSocket from "ws";
import type { ShardConfig, ShardNode } from "../hashring/config.js";
import { tryParseClusterGossipMessage, type ClusterGossipMessage } from "./protocol.js";

export interface ClusterGossipOptions {
  nodeId: string;
  shards: ShardConfig[];
  log: (event: string, fields?: Record<string, unknown>) => void;
  heartbeatIntervalMs: number;
  connect?: (url: string) => WebSocket;
}

interface GossipConn {
  socket: WebSocket;
  url: string;
}

export class ClusterGossip {
  private readonly nodeId: string;
  private readonly shards: ShardConfig[];
  private readonly nodes: ShardNode[];
  private readonly log: ClusterGossipOptions["log"];
  private readonly heartbeatIntervalMs: number;
  private readonly connectFn: (url: string) => WebSocket;
  private readonly leaders = new Map<string, { leaderId: string; leaderUrl: string }>();
  private readonly connections = new Map<string, GossipConn>();
  private stopped = false;

  constructor(options: ClusterGossipOptions) {
    this.nodeId = options.nodeId;
    this.shards = options.shards;
    this.nodes = [...new Map(options.shards.flatMap((shard) => [shard.leader, ...shard.followers]).map((node) => [node.id, node])).values()]
      .filter((node) => node.id !== options.nodeId);
    this.log = options.log;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs;
    this.connectFn = options.connect ?? ((url) => new WebSocket(url));

    for (const shard of options.shards) {
      this.leaders.set(shard.id, { leaderId: shard.leader.id, leaderUrl: shard.leader.url });
    }
  }

  getCurrentLeaderUrl(shardId: string): string | undefined {
    return this.leaders.get(shardId)?.leaderUrl;
  }

  start(): void {
    for (const node of this.nodes) {
      if (this.nodeId < node.id) this.connectToPeer(node);
    }
    this.announceAll();
  }

  stop(): void {
    this.stopped = true;
    for (const connection of this.connections.values()) {
      connection.socket.removeAllListeners();
      connection.socket.close();
    }
    this.connections.clear();
  }

  handleInboundRaw(socket: WebSocket, raw: string): boolean {
    const message = tryParseClusterGossipMessage(raw);
    if (!message) return false;
    this.handleMessage(socket, message);
    return true;
  }

  announceOwnShardLeader(shardId: string, leaderId: string): void {
    const shard = this.shards.find((candidate) => candidate.id === shardId);
    const leader = shard && [shard.leader, ...shard.followers].find((node) => node.id === leaderId);
    if (!leader) return;
    const message: ClusterGossipMessage = {
      type: "SHARD_LEADER_ANNOUNCE",
      shardId,
      leaderId,
      leaderUrl: leader.url
    };
    this.leaders.set(shardId, { leaderId, leaderUrl: leader.url });
    this.broadcast(message);
  }

  private announceAll(): void {
    for (const shard of this.shards) {
      this.broadcast({
        type: "SHARD_LEADER_ANNOUNCE",
        shardId: shard.id,
        leaderId: this.leaders.get(shard.id)!.leaderId,
        leaderUrl: this.leaders.get(shard.id)!.leaderUrl
      });
    }
  }

  private broadcast(message: ClusterGossipMessage): void {
    const payload = JSON.stringify(message);
    for (const connection of this.connections.values()) {
      if (connection.socket.readyState === WebSocket.OPEN) {
        try {
          connection.socket.send(payload);
        } catch {
          // The close handler retries outbound connections.
        }
      }
    }
  }

  private connectToPeer(peer: ShardNode): void {
    if (this.stopped || this.connections.has(peer.id)) return;
    const socket = this.connectFn(peer.url);
    this.connections.set(peer.id, { socket, url: peer.url });

    socket.on("open", () => this.announceAll());
    socket.on("message", (data) => {
      const message = tryParseClusterGossipMessage(data.toString("utf8"));
      if (message) this.handleMessage(socket, message);
    });
    socket.on("close", () => {
      this.connections.delete(peer.id);
      if (!this.stopped) setTimeout(() => this.connectToPeer(peer), Math.min(this.heartbeatIntervalMs, 1000));
    });
    socket.on("error", () => {
      // close drives reconnects for ws errors.
    });
  }

  private handleMessage(socket: WebSocket, message: ClusterGossipMessage): void {
    const knownShard = this.shards.some((shard) => shard.id === message.shardId);
    const knownLeader = this.shards.some(
      (shard) => shard.id === message.shardId && [shard.leader, ...shard.followers].some((node) => node.id === message.leaderId && node.url === message.leaderUrl)
    );
    if (!knownShard || !knownLeader) return;

    const previous = this.leaders.get(message.shardId);
    this.leaders.set(message.shardId, { leaderId: message.leaderId, leaderUrl: message.leaderUrl });
    if (previous?.leaderId !== message.leaderId || previous.leaderUrl !== message.leaderUrl) {
      this.log("shard_leader_gossip", { shard: message.shardId, leader: message.leaderId });
      this.broadcastExcept(socket, message);
    }
  }

  private broadcastExcept(excluded: WebSocket, message: ClusterGossipMessage): void {
    const payload = JSON.stringify(message);
    for (const connection of this.connections.values()) {
      if (connection.socket !== excluded && connection.socket.readyState === WebSocket.OPEN) {
        try {
          connection.socket.send(payload);
        } catch {
          // Ignore disconnected peers.
        }
      }
    }
  }
}