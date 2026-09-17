import WebSocket from "ws";
import type { Store } from "../engine/store.js";
import type { ShardNode } from "../hashring/config.js";
import type { AofEntry, AofLog } from "../persistence/aof.js";
import { selectPromotedLeader } from "./promotion.js";
import { tryParsePeerMessage, type PeerMessage } from "./protocol.js";

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
}

interface PeerConnState {
  socket: WebSocket | null;
  url: string;
  lastHeartbeatAt: number;
  outbound: boolean;
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

  private currentLeaderId: string;
  private lastSeenFromLeaderAt: number;
  private replSeq = 0;
  private lastAppliedSeq = 0;
  private lastAppliedLeaderId: string | null = null;

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

  start(): void {
    // Deterministic, no duplicate edges: a pair of shard peers gets exactly
    // one connection between them, always initiated by the lexicographically
    // smaller node id; the other side accepts it inbound via registerInboundPeer.
    for (const peer of this.peers) {
      if (this.nodeId < peer.id) this.connectToPeer(peer);
    }

    this.heartbeatTimer = setInterval(() => this.sendHeartbeats(), this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();

    this.failoverTimer = setInterval(() => this.checkFailover(), this.heartbeatIntervalMs);
    this.failoverTimer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.failoverTimer) clearInterval(this.failoverTimer);
    for (const conn of this.connections.values()) {
      conn.socket?.removeAllListeners();
      conn.socket?.close();
    }
    this.connections.clear();
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

    let message: PeerMessage;
    switch (entry.op) {
      case "SET":
        message = {
          type: "REPL_OP",
          leaderId: this.nodeId,
          seq: this.replSeq,
          op: "SET",
          key: entry.key,
          value: entry.value,
          expiresAt: entry.expiresAt
        };
        break;
      case "DEL":
        message = { type: "REPL_OP", leaderId: this.nodeId, seq: this.replSeq, op: "DEL", key: entry.key };
        break;
      case "EXPIRE":
        message = {
          type: "REPL_OP",
          leaderId: this.nodeId,
          seq: this.replSeq,
          op: "EXPIRE",
          key: entry.key,
          expiresAt: entry.expiresAt
        };
        break;
    }

    const payload = JSON.stringify(message);
    for (const conn of this.connections.values()) {
      if (conn.socket?.readyState === WebSocket.OPEN) {
        try {
          conn.socket.send(payload);
        } catch {
          // The peer's own close handler will reconnect; nothing to do here.
        }
      }
    }
  }

  private connectToPeer(peer: ShardNode): void {
    if (this.stopped) return;
    const socket = this.connectFn(peer.url);
    this.connections.set(peer.id, { socket, url: peer.url, lastHeartbeatAt: 0, outbound: true });

    socket.on("open", () => {
      socket.send(JSON.stringify({ type: "PEER_HELLO", nodeId: this.nodeId, shardId: this.shardId }));
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

  private registerInboundPeer(nodeId: string, shardId: string, socket: WebSocket): void {
    if (shardId !== this.shardId) return;
    const known = this.peers.some((candidate) => candidate.id === nodeId);
    if (!known) return;

    const existing = this.connections.get(nodeId);
    if (existing?.outbound) return; // the canonical edge to this peer already exists

    this.connections.set(nodeId, { socket, url: existing?.url ?? "", lastHeartbeatAt: this.now(), outbound: false });
    socket.send(JSON.stringify({ type: "PEER_HELLO", nodeId: this.nodeId, shardId: this.shardId }));
  }

  private handlePeerMessage(fromSocket: WebSocket, message: PeerMessage): void {
    switch (message.type) {
      case "PEER_HELLO":
        this.registerInboundPeer(message.nodeId, message.shardId, fromSocket);
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
        this.log("replication_ack", { from: message.nodeId, seq: message.seq });
        return;
    }
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
  }
}
