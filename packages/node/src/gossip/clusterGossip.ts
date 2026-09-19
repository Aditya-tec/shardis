import WebSocket from "ws";
import { existsSync, readFileSync } from "node:fs";
import type { ShardConfig, ShardNode } from "../hashring/config.js";
import { SLOT_COUNT } from "../hashring/hash.js";
import { durableWriteAndRename } from "../persistence/snapshot.js";
import { tryParseClusterGossipMessage, type ClusterGossipMessage } from "./protocol.js";
import { writeKeyValid } from "../security/safeCompare.js";

export interface ClusterGossipOptions {
  nodeId: string;
  shards: ShardConfig[];
  log: (event: string, fields?: Record<string, unknown>) => void;
  heartbeatIntervalMs: number;
  connect?: (url: string) => WebSocket;
  clusterSecret?: string;
  slotStatePath?: string;
  onPublishRelay?: (channel: string, message: string) => void;
}

export interface MigratingSlot {
  slot: number;
  fromShard: string;
  toShard: string;
}

interface SlotStateFile {
  ownership: string[];
  migrating: MigratingSlot[];
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
  private readonly clusterSecret?: string;
  private readonly slotStatePath?: string;
  private readonly onPublishRelay?: (channel: string, message: string) => void;
  private readonly initialOwnership: string[];

  // Runtime slot ownership: 16384 entries, one per CRC16 slot.
  // Initialized from the static cluster config; updated in-place as slots
  // migrate. This is the authoritative routing table for all nodes — when a
  // client key hashes to a slot, this table decides which shard handles it.
  private readonly slotOwnership: string[];

  // Slots currently in flight between shards, keyed by slot number.
  private readonly migratingSlots = new Map<number, { fromShard: string; toShard: string }>();
  private readonly importingSlots = new Map<number, { fromShard: string; toShard: string }>();

  constructor(options: ClusterGossipOptions) {
    this.nodeId = options.nodeId;
    this.shards = options.shards;
    this.nodes = [...new Map(options.shards.flatMap((shard) => [shard.leader, ...shard.followers]).map((node) => [node.id, node])).values()]
      .filter((node) => node.id !== options.nodeId);
    this.log = options.log;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs;
    this.connectFn = options.connect ?? ((url) => new WebSocket(url));
    this.clusterSecret = options.clusterSecret;
    this.slotStatePath = options.slotStatePath;
    this.onPublishRelay = options.onPublishRelay;

    for (const shard of options.shards) {
      this.leaders.set(shard.id, { leaderId: shard.leader.id, leaderUrl: shard.leader.url });
    }

    // Initialize slot ownership from the static config.
    this.slotOwnership = new Array<string>(SLOT_COUNT);
    for (const shard of options.shards) {
      for (let slot = shard.hash_range[0]; slot <= shard.hash_range[1]; slot++) {
        this.slotOwnership[slot] = shard.id;
      }
    }
    this.initialOwnership = this.slotOwnership.slice();
    this.loadPersistedState();
  }

  getCurrentLeaderUrl(shardId: string): string | undefined {
    return this.leaders.get(shardId)?.leaderUrl;
  }

  /** Returns the shardId that currently owns `slot` per the runtime ownership table. */
  shardForSlot(slot: number): string | undefined {
    return this.slotOwnership[slot];
  }

  /** True while `slot` is being migrated out of this shard (keys may still be here). */
  isSlotMigrating(slot: number): boolean {
    return this.migratingSlots.has(slot);
  }

  /** True while `slot` is being migrated *out of this shard*. */
  isSlotMigratingFrom(slot: number, shardId: string): boolean {
    return this.migratingSlots.get(slot)?.fromShard === shardId;
  }

  /** True while `slot` is being imported *into this shard*. */
  isSlotImportingTo(slot: number, shardId: string): boolean {
    return this.importingSlots.get(slot)?.toShard === shardId;
  }

  getMigratingSlots(): MigratingSlot[] {
    return [...this.migratingSlots.entries()].map(([slot, info]) => ({ slot, ...info }));
  }

  getSlotState(): { migrating: MigratingSlot[]; importing: MigratingSlot[] } {
    return {
      migrating: this.getMigratingSlots(),
      importing: [...this.importingSlots.entries()].map(([slot, info]) => ({ slot, ...info }))
    };
  }

  /** Destination leader URL for a slot currently being imported, used to build ASK redirects. */
  migrationDestUrl(slot: number): string | undefined {
    const info = this.migratingSlots.get(slot);
    if (!info) return undefined;
    return this.leaders.get(info.toShard)?.leaderUrl;
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
      const socket = connection.socket;
      socket.removeAllListeners();
      if (socket.readyState === WebSocket.CONNECTING) {
        // ws can have a short window where readyState is CONNECTING but its
        // internal request has not been assigned yet. Its public close and
        // terminate methods both assume that request exists.
        socket.once("error", () => undefined);
        const request = (socket as WebSocket & { _req?: { destroy?: () => void } })._req;
        request?.destroy?.();
      } else if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CLOSING) {
        socket.close();
      }
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
      leaderUrl: leader.url,
      clusterSecret: this.clusterSecret
    };
    this.leaders.set(shardId, { leaderId, leaderUrl: leader.url });
    this.broadcast(message);
  }

  /**
   * Begin migrating `slot` from `fromShard` to `toShard`.
   * Gossips SLOT_MIGRATING + SLOT_IMPORTING to all peers so every node
   * knows to issue ASK redirects for keys-not-found in this slot.
   */
  beginSlotMigration(slot: number, fromShard: string, toShard: string): void {
    this.migratingSlots.set(slot, { fromShard, toShard });
    this.importingSlots.set(slot, { fromShard, toShard });
    const migrating: ClusterGossipMessage = { type: "SLOT_MIGRATING", slot, fromShard, toShard };
    const importing: ClusterGossipMessage = { type: "SLOT_IMPORTING", slot, fromShard, toShard };
    this.broadcast(migrating);
    this.broadcast(importing);
    this.persistState();
    this.log("slot_migration_started", { slot, fromShard, toShard });
  }

  /**
   * Finalize slot ownership after all keys have been transferred.
   * Gossips SLOT_OWNED so all nodes update their routing tables.
   */
  finalizeSlotMigration(slot: number, toShard: string): void {
    this.slotOwnership[slot] = toShard;
    this.migratingSlots.delete(slot);
    this.importingSlots.delete(slot);
    const message: ClusterGossipMessage = { type: "SLOT_OWNED", slot, shard: toShard };
    this.broadcast(message);
    this.persistState();
    this.log("slot_migration_complete", { slot, newOwner: toShard });
  }

  relayPublish(channel: string, message: string): void {
    this.broadcast({ type: "PUBLISH_RELAY", channel, message });
  }

  private announceAll(): void {
    for (const shard of this.shards) {
      this.broadcast({
        type: "SHARD_LEADER_ANNOUNCE",
        shardId: shard.id,
        leaderId: this.leaders.get(shard.id)!.leaderId,
        leaderUrl: this.leaders.get(shard.id)!.leaderUrl,
        clusterSecret: this.clusterSecret
      });
    }
    const diffs: Array<{ slot: number; shard: string }> = [];
    for (let slot = 0; slot < SLOT_COUNT; slot++) {
      if (this.slotOwnership[slot] !== this.initialOwnership[slot]) {
        diffs.push({ slot, shard: this.slotOwnership[slot] });
      }
    }
    if (diffs.length > 0 || this.migratingSlots.size > 0) {
      this.broadcast({
        type: "SLOT_TABLE",
        diffs,
        migrating: this.getMigratingSlots()
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
    if (message.type === "SHARD_LEADER_ANNOUNCE") {
      this.handleLeaderAnnounce(socket, message);
      return;
    }
    if (message.type === "SLOT_MIGRATING") {
      this.migratingSlots.set(message.slot, { fromShard: message.fromShard, toShard: message.toShard });
      this.log("slot_migrating_received", { slot: message.slot, fromShard: message.fromShard, toShard: message.toShard });
      this.broadcastExcept(socket, message);
      this.persistState();
      return;
    }
    if (message.type === "SLOT_IMPORTING") {
      this.importingSlots.set(message.slot, { fromShard: message.fromShard, toShard: message.toShard });
      this.broadcastExcept(socket, message);
      return;
    }
    if (message.type === "SLOT_OWNED") {
      const previous = this.slotOwnership[message.slot];
      this.slotOwnership[message.slot] = message.shard;
      this.migratingSlots.delete(message.slot);
      this.importingSlots.delete(message.slot);
      if (previous !== message.shard) {
        this.log("slot_ownership_updated", { slot: message.slot, from: previous, to: message.shard });
        this.broadcastExcept(socket, message);
        this.persistState();
      }
      return;
    }
    if (message.type === "SLOT_TABLE") {
      for (const diff of message.diffs) this.slotOwnership[diff.slot] = diff.shard;
      this.migratingSlots.clear();
      this.importingSlots.clear();
      for (const entry of message.migrating) {
        this.migratingSlots.set(entry.slot, { fromShard: entry.fromShard, toShard: entry.toShard });
        this.importingSlots.set(entry.slot, { fromShard: entry.fromShard, toShard: entry.toShard });
      }
      this.persistState();
      return;
    }
    if (message.type === "PUBLISH_RELAY") {
      this.onPublishRelay?.(message.channel, message.message);
    }
  }

  private handleLeaderAnnounce(
    socket: WebSocket,
    message: Extract<ClusterGossipMessage, { type: "SHARD_LEADER_ANNOUNCE" }>
  ): void {
    // Validate cluster secret if configured.
    if (this.clusterSecret) {
      if (!writeKeyValid(message.clusterSecret, this.clusterSecret)) {
        this.log("peer_auth_rejected", { reason: "invalid_cluster_secret", type: "SHARD_LEADER_ANNOUNCE" });
        socket.close(1008, "invalid cluster secret");
        return;
      }
    }

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

  private loadPersistedState(): void {
    if (!this.slotStatePath || !existsSync(this.slotStatePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.slotStatePath, "utf8")) as SlotStateFile;
      if (Array.isArray(parsed.ownership) && parsed.ownership.length === SLOT_COUNT) {
        for (let slot = 0; slot < SLOT_COUNT; slot++) {
          if (typeof parsed.ownership[slot] === "string") this.slotOwnership[slot] = parsed.ownership[slot];
        }
      }
      if (Array.isArray(parsed.migrating)) {
        for (const entry of parsed.migrating) {
          this.migratingSlots.set(entry.slot, { fromShard: entry.fromShard, toShard: entry.toShard });
          this.importingSlots.set(entry.slot, { fromShard: entry.fromShard, toShard: entry.toShard });
          this.log("slot_migration_stuck", { slot: entry.slot, fromShard: entry.fromShard, toShard: entry.toShard });
        }
      }
    } catch {
      this.log("slot_state_load_failed", { path: this.slotStatePath });
    }
  }

  private persistState(): void {
    if (!this.slotStatePath) return;
    const payload: SlotStateFile = {
      ownership: this.slotOwnership,
      migrating: this.getMigratingSlots()
    };
    durableWriteAndRename(this.slotStatePath, JSON.stringify(payload));
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