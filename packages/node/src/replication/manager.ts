import WebSocket from "ws";
import type { Store } from "../engine/store.js";
import type { ShardNode } from "../hashring/config.js";
import type { AofEntry, AofLog } from "../persistence/aof.js";
import { selectPromotedLeader } from "./promotion.js";
import { tryParsePeerMessage, type PeerMessage } from "./protocol.js";
import { writeKeyValid } from "../security/safeCompare.js";

// Backpressure thresholds for the per-follower WebSocket send buffer.
// ponytail: fixed byte ceilings rather than flow-control protocol — simple
// and bounded. Ceiling: if a follower falls far enough behind that these
// limits matter, it will reconnect and do a full resync, which is already
// implemented and correct.
export const REPL_BACKPRESSURE_THRESHOLD_BYTES = 1 * 1024 * 1024;   // 1 MB: pause sends
export const REPL_DISCONNECT_THRESHOLD_BYTES  = 16 * 1024 * 1024;  // 16 MB: force reconnect

export interface ReplicationManagerOptions {
  nodeId: string;
  shardId: string;
  peers: ShardNode[]; // other members of this node's shard (excludes self)
  initialLeaderId: string;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  store: Store;
  aofLog: AofLog;
  log: (event: string, fields?: Record<string, unknown>) => void;
  now?: () => number;
  connect?: (url: string) => WebSocket;
  // Called after a follower applies a full resync from its leader, so the
  // caller can persist it as a fresh snapshot baseline (reusing app.ts's
  // existing snapshotNow, which also truncates the AOF).
  onFullSyncApplied?: () => void;
  onLeaderChanged?: (leaderId: string) => void;
  nodeUrl?: string;
  joinUrl?: string;
  clusterSecret?: string;
}

interface PeerConnState {
  socket: WebSocket | null;
  url: string;
  lastHeartbeatAt: number;
  outbound: boolean;
  lagging: boolean; // true when bufferedAmount >= REPL_BACKPRESSURE_THRESHOLD_BYTES
}

export class ReplicationManager {
  private readonly nodeId: string;
  private readonly shardId: string;
  private readonly peers: ShardNode[];
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly store: Store;
  private readonly aofLog: AofLog;
  private readonly log: ReplicationManagerOptions["log"];
  private readonly now: () => number;
  private readonly connectFn: (url: string) => WebSocket;
  private readonly onFullSyncApplied?: () => void;
  private readonly onLeaderChanged?: (leaderId: string) => void;
  private readonly nodeUrl?: string;
  private readonly joinUrl?: string;
  private readonly clusterSecret?: string;

  private currentLeaderId: string;
  private lastSeenFromLeaderAt: number;
  private replSeq = 0;
  private lastAppliedSeq = 0;
  private lastAppliedLeaderId: string | null = null;
  private lastLagMs: number | null = null;
  // Per-peer ACK tracking (leader only): when did we last receive REPL_ACK
  // from each follower? Used to compute per-follower replication lag for /metrics.
  private readonly peerLastAckTs = new Map<string, number>();

  private readonly connections = new Map<string, PeerConnState>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private failoverTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(options: ReplicationManagerOptions) {
    this.nodeId = options.nodeId;
    this.shardId = options.shardId;
    this.peers = options.peers;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs;
    this.store = options.store;
    this.aofLog = options.aofLog;
    this.log = options.log;
    this.now = options.now ?? Date.now;
    this.connectFn = options.connect ?? ((url) => new WebSocket(url));
    this.onFullSyncApplied = options.onFullSyncApplied;
    this.onLeaderChanged = options.onLeaderChanged;
    this.nodeUrl = options.nodeUrl;
    this.joinUrl = options.joinUrl;
    this.clusterSecret = options.clusterSecret;
    this.currentLeaderId = options.initialLeaderId;
    this.lastSeenFromLeaderAt = this.now();
  }

  isLeader(): boolean {
    return this.currentLeaderId === this.nodeId;
  }

  getCurrentLeaderId(): string {
    return this.currentLeaderId;
  }

  getCurrentLeaderUrl(): string {
    if (this.currentLeaderId === this.nodeId) {
      throw new Error("this node is the current leader; it has no external URL for itself");
    }
    const peer = this.peers.find((candidate) => candidate.id === this.currentLeaderId);
    if (!peer) throw new Error(`unknown leader id ${this.currentLeaderId}, not in shard peer list`);
    return peer.url;
  }

  getConnectedPeerIds(): string[] {
    return [...this.connections.keys()];
  }

  // Time between the leader broadcasting a write and this node applying it,
  // measured from the last REPL_OP applied. Only meaningful on a follower;
  // null before any replication traffic has been seen.
  getLastReplicationLagMs(): number | null {
    return this.lastLagMs;
  }

  // Per-follower lag as seen from the leader: time since the last REPL_ACK
  // from each connected follower.  null = follower connected but never ACKed.
  // Only populated when isLeader() is true.
  getPerFollowerLagMs(): Record<string, number | null> {
    const result: Record<string, number | null> = {};
    const now = this.now();
    for (const peerId of this.connections.keys()) {
      const lastAck = this.peerLastAckTs.get(peerId);
      result[peerId] = lastAck !== undefined ? now - lastAck : null;
    }
    return result;
  }

  getPerFollowerLagging(): Record<string, boolean> {
    const result: Record<string, boolean> = {};
    for (const [peerId, conn] of this.connections.entries()) {
      result[peerId] = conn.lagging;
    }
    return result;
  }

  start(): void {
    // Deterministic, no duplicate edges: a pair of shard peers gets exactly
    // one connection between them, always initiated by the lexicographically
    // smaller node id; the other side accepts it inbound via registerInboundPeer.
    for (const peer of this.peers) {
      if (this.nodeId < peer.id) this.connectToPeer(peer);
    }
    if (this.joinUrl && this.nodeUrl) this.sendMemberJoin();

    this.heartbeatTimer = setInterval(() => this.sendHeartbeats(), this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();

    this.failoverTimer = setInterval(() => this.checkFailover(), this.heartbeatIntervalMs);
    this.failoverTimer.unref?.();
  }

  stop(): void {
    this.broadcastMembership({ type: "MEMBER_LEAVE", nodeId: this.nodeId, shardId: this.shardId });
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.failoverTimer) clearInterval(this.failoverTimer);
    for (const conn of this.connections.values()) {
      conn.socket?.removeAllListeners();
      conn.socket?.close();
    }
    this.connections.clear();
  }

  addPeer(peer: ShardNode): void {
    if (peer.id === this.nodeId) return;
    const existing = this.peers.find((candidate) => candidate.id === peer.id);
    if (existing) {
      existing.url = peer.url;
    } else {
      this.peers.push(peer);
    }
    if (this.nodeId < peer.id && !this.connections.has(peer.id)) this.connectToPeer(peer);
  }

  removePeer(nodeId: string): void {
    const index = this.peers.findIndex((peer) => peer.id === nodeId);
    if (index >= 0) this.peers.splice(index, 1);
    const connection = this.connections.get(nodeId);
    connection?.socket?.close();
    this.connections.delete(nodeId);
  }

  // Called by app.ts for every raw message on an accepted (inbound) socket,
  // before client-protocol parsing. Returns true if this message was a peer
  // message and has been fully handled (so app.ts should not also treat it
  // as a client request).
  handleInboundRaw(socket: WebSocket, raw: string): boolean {
    const message = tryParsePeerMessage(raw);
    if (!message) return false;
    this.handlePeerMessage(socket, message);
    return true;
  }

  // Called by app.ts right after a client-driven write has been applied and
  // durably persisted locally by the current leader, to fan it out to peers.
  afterLocalWrite(entry: AofEntry): void {
    if (!this.isLeader()) return;
    this.replSeq += 1;
    const ts = this.now();

    let message: PeerMessage;
    switch (entry.op) {
      case "SET":
        message = {
          type: "REPL_OP",
          leaderId: this.nodeId,
          seq: this.replSeq,
          ts,
          op: "SET",
          key: entry.key,
          value: entry.value,
          expiresAt: entry.expiresAt
        };
        break;
      case "DEL":
        message = { type: "REPL_OP", leaderId: this.nodeId, seq: this.replSeq, ts, op: "DEL", key: entry.key };
        break;
      case "EXPIRE":
        message = {
          type: "REPL_OP",
          leaderId: this.nodeId,
          seq: this.replSeq,
          ts,
          op: "EXPIRE",
          key: entry.key,
          expiresAt: entry.expiresAt
        };
        break;
    }

    const payload = JSON.stringify(message);
    for (const [peerId, conn] of this.connections.entries()) {
      if (conn.socket?.readyState !== WebSocket.OPEN) continue;

      // Backpressure: check the WebSocket send buffer.  If the peer can't
      // keep up, stop sending new ops to it (it will full-resync on reconnect
      // if it disconnects). At the hard ceiling, close the connection so the
      // follower reconnects and triggers a clean SYNC_REQUEST.
      const buffered = (conn.socket as WebSocket & { bufferedAmount?: number }).bufferedAmount ?? 0;
      if (buffered >= REPL_DISCONNECT_THRESHOLD_BYTES) {
        this.log("replication_follower_disconnected", { peerId, bufferedAmount: buffered, reason: "hard_threshold" });
        conn.socket.close();
        continue;
      }
      if (buffered >= REPL_BACKPRESSURE_THRESHOLD_BYTES) {
        conn.lagging = true;
        this.log("replication_lagging", { peerId, bufferedAmount: buffered });
        continue; // skip this send; follower will catch up on reconnect via full sync
      }
      conn.lagging = false;

      try {
        conn.socket.send(payload);
      } catch {
        // The peer's own close handler will reconnect; nothing to do here.
      }
    }
  }

  private connectToPeer(peer: ShardNode): void {
    if (this.stopped) return;
    const socket = this.connectFn(peer.url);
    this.connections.set(peer.id, { socket, url: peer.url, lastHeartbeatAt: 0, outbound: true, lagging: false });

    socket.on("open", () => {
      socket.send(JSON.stringify({ type: "PEER_HELLO", nodeId: this.nodeId, shardId: this.shardId, clusterSecret: this.clusterSecret }));
      if (peer.id === this.currentLeaderId) this.requestSyncFrom(peer.id);
    });

    socket.on("message", (data) => {
      const message = tryParsePeerMessage(data.toString("utf8"));
      if (message) this.handlePeerMessage(socket, message);
    });

    socket.on("close", () => {
      if (this.stopped) return;
      // Peers restart independently of each other (e.g. a killed leader
      // coming back later), so keep retrying on a short fixed backoff.
      setTimeout(() => this.connectToPeer(peer), Math.min(this.heartbeatIntervalMs, 1000));
    });

    socket.on("error", () => {
      // 'close' always follows 'error' for ws; the close handler drives the retry.
    });
  }

  private registerInboundPeer(nodeId: string, shardId: string, socket: WebSocket, clusterSecret?: string): void {
    if (shardId !== this.shardId) return;
    const known = this.peers.some((candidate) => candidate.id === nodeId);
    if (!known) return;

    // Validate CLUSTER_SECRET if configured. Use safeCompare to prevent
    // timing-based leaks of the secret value.
    if (this.clusterSecret) {
      if (!writeKeyValid(clusterSecret, this.clusterSecret)) {
        this.log("peer_auth_rejected", { peerId: nodeId, reason: "invalid_cluster_secret" });
        socket.close(1008, "invalid cluster secret");
        return;
      }
    }

    const existing = this.connections.get(nodeId);
    if (existing?.outbound) return; // the canonical edge to this peer already exists

    this.connections.set(nodeId, { socket, url: existing?.url ?? "", lastHeartbeatAt: this.now(), outbound: false, lagging: false });
    socket.send(JSON.stringify({ type: "PEER_HELLO", nodeId: this.nodeId, shardId: this.shardId, clusterSecret: this.clusterSecret }));
    if (nodeId === this.currentLeaderId) this.requestSyncFrom(nodeId);
  }

  private sendMemberJoin(): void {
    const socket = this.connectFn(this.joinUrl!);
    socket.on("open", () => {
      socket.send(JSON.stringify({ type: "MEMBER_JOIN", nodeId: this.nodeId, shardId: this.shardId, url: this.nodeUrl }));
      setTimeout(() => socket.close(), 100);
    });
    socket.on("error", () => socket.close());
  }

  private requestSyncFrom(peerId: string): void {
    const conn = this.connections.get(peerId);
    if (conn?.socket?.readyState === WebSocket.OPEN) {
      conn.socket.send(JSON.stringify({ type: "SYNC_REQUEST", nodeId: this.nodeId }));
    }
  }

  private handlePeerMessage(fromSocket: WebSocket, message: PeerMessage): void {
    switch (message.type) {
      case "PEER_HELLO":
        this.registerInboundPeer(message.nodeId, message.shardId, fromSocket, message.clusterSecret);
        return;
      case "MEMBER_JOIN":
        if (message.shardId !== this.shardId || message.nodeId === this.nodeId) return;
        this.addPeer({ id: message.nodeId, url: message.url });
        this.relayMembership(fromSocket, { type: "MEMBER_ANNOUNCE", nodeId: message.nodeId, shardId: message.shardId, url: message.url });
        fromSocket.send(JSON.stringify({ type: "MEMBER_ANNOUNCE", nodeId: this.nodeId, shardId: this.shardId, url: this.nodeUrl ?? "" }));
        return;
      case "MEMBER_ANNOUNCE":
        if (message.shardId !== this.shardId || message.nodeId === this.nodeId) return;
        this.addPeer({ id: message.nodeId, url: message.url });
        this.relayMembership(fromSocket, message);
        return;
      case "MEMBER_LEAVE":
        if (message.shardId !== this.shardId) return;
        this.removePeer(message.nodeId);
        this.relayMembership(fromSocket, message);
        return;
      case "HEARTBEAT":
        this.noteLiveness(message.nodeId);
        this.considerLeaderClaim(message.nodeId, message.leaderId);
        return;
      case "REPL_OP":
        this.noteLiveness(message.leaderId);
        this.considerLeaderClaim(message.leaderId, message.leaderId);
        this.applyReplOp(message);
        fromSocket.send(
          JSON.stringify({ type: "REPL_ACK", nodeId: this.nodeId, leaderId: message.leaderId, seq: message.seq })
        );
        return;
      case "REPL_ACK":
        this.peerLastAckTs.set(message.nodeId, this.now());
        this.log("replication_ack", { from: message.nodeId, seq: message.seq });
        return;
      case "SYNC_REQUEST":
        if (this.isLeader()) {
          fromSocket.send(JSON.stringify({ type: "SYNC_RESPONSE", entries: this.store.dump() }));
          this.log("full_sync_sent", { to: message.nodeId, keys: this.store.size });
        }
        return;
      case "SYNC_RESPONSE":
        this.applyFullSync(message.entries);
        return;
    }
  }

  private relayMembership(fromSocket: WebSocket, message: Extract<PeerMessage, { type: "MEMBER_ANNOUNCE" | "MEMBER_LEAVE" }>): void {
    const payload = JSON.stringify(message);
    for (const connection of this.connections.values()) {
      const socket = connection.socket;
      if (socket && socket !== fromSocket && socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(payload);
        } catch {
          // Ignore disconnected peers.
        }
      }
    }
  }

  private broadcastMembership(message: Extract<PeerMessage, { type: "MEMBER_ANNOUNCE" | "MEMBER_LEAVE" }>): void {
    const payload = JSON.stringify(message);
    for (const connection of this.connections.values()) {
      const socket = connection.socket;
      if (socket?.readyState === WebSocket.OPEN) {
        try {
          socket.send(payload);
        } catch {
          // Ignore disconnected peers during shutdown.
        }
      }
    }
  }

  // Applied when this node (re)connects to its leader: replaces local state
  // wholesale rather than merging, so writes made elsewhere while this node
  // was offline (or brand new) are picked up instead of silently missing -
  // ongoing REPL_OPs alone only cover writes made *after* a connection is
  // live, not whatever already happened before it.
  private applyFullSync(entries: Array<{ key: string; value: string; expiresAt: number | null }>): void {
    this.store.clear();
    for (const entry of entries) this.store.restoreSet(entry.key, entry.value, entry.expiresAt);
    this.onFullSyncApplied?.();
    this.log("full_sync_applied", { keys: entries.length });
  }

  private applyReplOp(message: Extract<PeerMessage, { type: "REPL_OP" }>): void {
    // Dedup is scoped per leader epoch: a newly promoted leader restarts its
    // seq at 1, so switching who lastAppliedLeaderId is resets the counter
    // instead of comparing seq numbers across two unrelated leaders.
    if (this.lastAppliedLeaderId !== message.leaderId) {
      this.lastAppliedLeaderId = message.leaderId;
      this.lastAppliedSeq = 0;
    }
    if (message.seq <= this.lastAppliedSeq) return;
    this.lastAppliedSeq = message.seq;
    this.lastLagMs = Math.max(0, this.now() - message.ts);

    switch (message.op) {
      case "SET":
        this.aofLog.append({ op: "SET", key: message.key, value: message.value ?? "", expiresAt: message.expiresAt ?? null });
        this.store.restoreSet(message.key, message.value ?? "", message.expiresAt ?? null);
        break;
      case "DEL":
        this.aofLog.append({ op: "DEL", key: message.key });
        this.store.del(message.key);
        break;
      case "EXPIRE":
        this.aofLog.append({ op: "EXPIRE", key: message.key, expiresAt: message.expiresAt ?? 0 });
        this.store.restoreExpire(message.key, message.expiresAt ?? 0);
        break;
    }
    this.log("replication_applied", { op: message.op, key: message.key, seq: message.seq });
  }

  private noteLiveness(nodeId: string): void {
    const conn = this.connections.get(nodeId);
    if (conn) conn.lastHeartbeatAt = this.now();
    if (nodeId === this.currentLeaderId) this.lastSeenFromLeaderAt = this.now();
  }

  // Trusts a self-declaration ("I am the leader") from any known shard
  // peer, even overriding our own presumed leadership - this is what lets
  // a recovering former leader learn it has been superseded, and what lets
  // the other followers converge on a freshly promoted peer without each
  // needing to compute the election locally.
  private considerLeaderClaim(senderId: string, claimedLeaderId: string): void {
    if (senderId !== claimedLeaderId) return;
    if (claimedLeaderId === this.currentLeaderId) {
      if (claimedLeaderId !== this.nodeId) this.lastSeenFromLeaderAt = this.now();
      return;
    }

    const previous = this.currentLeaderId;
    this.currentLeaderId = claimedLeaderId;
    this.lastSeenFromLeaderAt = this.now();
    this.lastAppliedLeaderId = null;
    this.log("leader_changed", { previousLeader: previous, newLeader: claimedLeaderId, reason: "peer_claim" });
    this.onLeaderChanged?.(claimedLeaderId);

    if (claimedLeaderId !== this.nodeId) this.requestSyncFrom(claimedLeaderId);
  }

  private sendHeartbeats(): void {
    const payload = JSON.stringify({ type: "HEARTBEAT", nodeId: this.nodeId, leaderId: this.currentLeaderId });
    for (const conn of this.connections.values()) {
      if (conn.socket?.readyState === WebSocket.OPEN) {
        try {
          conn.socket.send(payload);
        } catch {
          // Ignore; the close handler (outbound) or disconnect (inbound) cleans up.
        }
      }
    }
  }

  private checkFailover(): void {
    if (this.isLeader()) return;
    if (this.now() - this.lastSeenFromLeaderAt < this.heartbeatTimeoutMs) return;

    const liveOtherIds = [...this.connections.entries()]
      .filter(([id, conn]) => id !== this.currentLeaderId && this.now() - conn.lastHeartbeatAt <= this.heartbeatTimeoutMs)
      .map(([id]) => id);

    const promoted = selectPromotedLeader(this.nodeId, liveOtherIds, this.currentLeaderId);
    if (promoted !== this.nodeId) return; // wait for the actual winner to announce itself

    const previous = this.currentLeaderId;
    this.currentLeaderId = this.nodeId;
    this.replSeq = 0;
    this.log("failover_triggered", { previousLeader: previous, newLeader: this.nodeId });
    this.onLeaderChanged?.(this.nodeId);
  }
}
