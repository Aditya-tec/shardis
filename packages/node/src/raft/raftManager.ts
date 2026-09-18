import WebSocket from "ws";
import type { Store } from "../engine/store.js";
import type { ShardNode } from "../hashring/config.js";
import type { AofEntry } from "../persistence/aof.js";
import type { ReplicationController } from "../replication/controller.js";
import { RaftLog } from "./log.js";
import { tryParseRaftMessage, type RaftMessage } from "./protocol.js";
import { loadRaftState, persistRaftState } from "./state.js";

export interface RaftManagerOptions {
  nodeId: string;
  shardId: string;
  peers: ShardNode[];
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  store: Store;
  aofLog: { append(entry: AofEntry): void };
  log: (event: string, fields?: Record<string, unknown>) => void;
  connect?: (url: string) => WebSocket;
  onLeaderChanged?: (leaderId: string) => void;
  statePath?: string;
}

interface Peer { node: ShardNode; socket: WebSocket | null; matchIndex: number; }

export class RaftManager implements ReplicationController {
  private readonly nodeId: string;
  private readonly peers: ShardNode[];
  private readonly heartbeatMs: number;
  private readonly timeoutMs: number;
  private readonly store: Store;
  private readonly aofLog: RaftManagerOptions["aofLog"];
  private readonly logEvent: RaftManagerOptions["log"];
  private readonly connectFn: (url: string) => WebSocket;
  private readonly onLeaderChanged?: (leaderId: string) => void;
  private readonly statePath?: string;
  private readonly peerState = new Map<string, Peer>();
  private readonly log = new RaftLog();
  private term: number;
  private votedFor: string | null;
  private leaderId: string | null = null;
  private role: "follower" | "candidate" | "leader" = "follower";
  private votes = new Set<string>();
  private commitIndex = -1;
  private appliedIndex = -1;
  private electionTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private lastLag: number | null = null;

  constructor(options: RaftManagerOptions) {
    this.nodeId = options.nodeId;
    this.peers = options.peers;
    this.heartbeatMs = options.heartbeatIntervalMs;
    this.timeoutMs = options.heartbeatTimeoutMs;
    this.store = options.store;
    this.aofLog = options.aofLog;
    this.logEvent = options.log;
    this.connectFn = options.connect ?? ((url) => new WebSocket(url));
    this.onLeaderChanged = options.onLeaderChanged;
    this.statePath = options.statePath;
    const state = this.statePath ? loadRaftState(this.statePath) : { currentTerm: 0, votedFor: null };
    this.term = state.currentTerm;
    this.votedFor = state.votedFor;
    for (const node of this.peers) this.peerState.set(node.id, { node, socket: null, matchIndex: -1 });
  }

  isLeader(): boolean { return this.role === "leader"; }
  getCurrentLeaderId(): string { return this.leaderId ?? this.nodeId; }
  getCurrentLeaderUrl(): string {
    const peer = this.peers.find((node) => node.id === this.leaderId);
    if (!peer) throw new Error(`unknown leader id ${this.leaderId}`);
    return peer.url;
  }
  getConnectedPeerIds(): string[] { return [...this.peerState].filter(([, peer]) => peer.socket?.readyState === WebSocket.OPEN).map(([id]) => id); }
  getLastReplicationLagMs(): number | null { return this.lastLag; }

  start(): void {
    for (const peer of this.peerState.values()) this.connect(peer);
    this.resetElectionTimer();
  }

  stop(): void {
    this.stopped = true;
    if (this.electionTimer) clearTimeout(this.electionTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const peer of this.peerState.values()) peer.socket?.close();
  }

  handleInboundRaw(socket: WebSocket, raw: string): boolean {
    const message = tryParseRaftMessage(raw);
    if (!message) return false;
    this.handle(socket, message);
    return true;
  }

  afterLocalWrite(entry: AofEntry): void {
    if (!this.isLeader()) return;
    this.log.append([{ term: this.term, entry }]);
    this.broadcastAppend();
    this.tryCommit();
  }

  private connect(peer: Peer): void {
    if (this.stopped || peer.socket) return;
    const socket = this.connectFn(peer.node.url);
    peer.socket = socket;
    socket.on("message", (data) => {
      const message = tryParseRaftMessage(data.toString("utf8"));
      if (message) this.handle(socket, message);
    });
    socket.on("close", () => { peer.socket = null; if (!this.stopped) setTimeout(() => this.connect(peer), this.heartbeatMs); });
    socket.on("error", () => undefined);
  }

  private send(socket: WebSocket | null, message: RaftMessage): void {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  private resetElectionTimer(): void {
    if (this.electionTimer) clearTimeout(this.electionTimer);
    const delay = electionTimeoutMs(this.timeoutMs);
    this.electionTimer = setTimeout(() => this.startElection(), delay);
    this.electionTimer.unref?.();
  }

  private startElection(): void {
    if (this.stopped || this.role === "leader") return;
    this.role = "candidate";
    this.term += 1;
    this.votedFor = this.nodeId;
    this.persistState();
    this.votes = new Set([this.nodeId]);
    this.leaderId = null;
    this.resetElectionTimer();
    for (const peer of this.peerState.values()) {
      this.send(peer.socket, { type: "RAFT_REQUEST_VOTE", term: this.term, candidateId: this.nodeId, lastLogIndex: this.log.lastIndex, lastLogTerm: this.log.lastTerm });
    }
    this.maybeBecomeLeader();
  }

  private maybeBecomeLeader(): void {
    if (this.votes.size <= (this.peers.length + 1) / 2) return;
    this.role = "leader";
    this.leaderId = this.nodeId;
    if (this.electionTimer) clearTimeout(this.electionTimer);
    this.heartbeatTimer = setInterval(() => this.broadcastAppend(), this.heartbeatMs);
    this.heartbeatTimer.unref?.();
    this.logEvent("raft_leader_elected", { term: this.term });
    this.onLeaderChanged?.(this.nodeId);
    this.broadcastAppend();
  }

  private handle(socket: WebSocket, message: RaftMessage): void {
    if (message.term > this.term) {
      this.term = message.term;
      this.role = "follower";
      this.votedFor = null;
      this.persistState();
    }
    if (message.type === "RAFT_REQUEST_VOTE") return this.handleVoteRequest(socket, message);
    if (message.type === "RAFT_VOTE") return this.handleVote(message);
    if (message.type === "RAFT_APPEND_ENTRIES") return this.handleAppend(socket, message);
    this.handleAppendResponse(message);
  }

  private handleVoteRequest(socket: WebSocket, message: Extract<RaftMessage, { type: "RAFT_REQUEST_VOTE" }>): void {
    const upToDate = isLogUpToDate(message.lastLogIndex, message.lastLogTerm, this.log.lastIndex, this.log.lastTerm);
    const granted = message.term === this.term && upToDate && (this.votedFor === null || this.votedFor === message.candidateId);
    if (granted) {
      this.votedFor = message.candidateId;
      this.persistState();
      this.resetElectionTimer();
    }
    this.send(socket, { type: "RAFT_VOTE", term: this.term, voterId: this.nodeId, granted });
  }

  private handleVote(message: Extract<RaftMessage, { type: "RAFT_VOTE" }>): void {
    if (this.role !== "candidate" || message.term !== this.term || !message.granted) return;
    this.votes.add(message.voterId);
    this.maybeBecomeLeader();
  }

  private handleAppend(socket: WebSocket, message: Extract<RaftMessage, { type: "RAFT_APPEND_ENTRIES" }>): void {
    if (message.term < this.term) { this.send(socket, { type: "RAFT_APPEND_RESPONSE", term: this.term, followerId: this.nodeId, success: false, matchIndex: this.log.lastIndex }); return; }
    this.role = "follower"; this.leaderId = message.leaderId; this.resetElectionTimer();
    const previous = message.prevLogIndex < 0 || this.log.at(message.prevLogIndex)?.term === message.prevLogTerm;
    if (!previous) { this.send(socket, { type: "RAFT_APPEND_RESPONSE", term: this.term, followerId: this.nodeId, success: false, matchIndex: this.log.lastIndex }); return; }
    this.log.truncateFrom(message.prevLogIndex + 1); this.log.append(message.entries);
    this.commitIndex = Math.min(message.leaderCommit, this.log.lastIndex); this.applyCommitted();
    this.send(socket, { type: "RAFT_APPEND_RESPONSE", term: this.term, followerId: this.nodeId, success: true, matchIndex: this.log.lastIndex });
  }

  private handleAppendResponse(message: Extract<RaftMessage, { type: "RAFT_APPEND_RESPONSE" }>): void {
    if (!this.isLeader() || message.term !== this.term) return;
    const peer = this.peerState.get(message.followerId);
    if (peer && message.success) peer.matchIndex = message.matchIndex;
    this.tryCommit();
  }

  private broadcastAppend(): void {
    if (!this.isLeader()) return;
    for (const peer of this.peerState.values()) {
      this.send(peer.socket, { type: "RAFT_APPEND_ENTRIES", term: this.term, leaderId: this.nodeId, prevLogIndex: this.log.lastIndex - this.log.slice(peer.matchIndex + 1).length, prevLogTerm: peer.matchIndex < 0 ? 0 : this.log.at(peer.matchIndex)?.term ?? 0, entries: this.log.slice(peer.matchIndex + 1), leaderCommit: this.commitIndex });
    }
  }

  private tryCommit(): void {
    if (!this.isLeader()) return;
    for (let index = this.commitIndex + 1; index <= this.log.lastIndex; index += 1) {
      const replicated = 1 + [...this.peerState.values()].filter((peer) => peer.matchIndex >= index).length;
      if (replicated > (this.peers.length + 1) / 2 && this.log.at(index)?.term === this.term) this.commitIndex = index;
    }
    this.applyCommitted();
  }

  private applyCommitted(): void {
    while (this.appliedIndex < this.commitIndex) {
      this.appliedIndex += 1;
      const entry = this.log.at(this.appliedIndex)?.entry;
      if (!entry) continue;
      this.aofLog.append(entry);
      if (entry.op === "SET") this.store.restoreSet(entry.key, entry.value, entry.expiresAt);
      if (entry.op === "DEL") this.store.del(entry.key);
      if (entry.op === "EXPIRE") this.store.restoreExpire(entry.key, entry.expiresAt);
    }
  }

  private persistState(): void {
    if (this.statePath) persistRaftState(this.statePath, { currentTerm: this.term, votedFor: this.votedFor });
  }
}

export function majorityCount(clusterSize: number): number {
  return Math.floor(clusterSize / 2) + 1;
}

export function isLogUpToDate(candidateIndex: number, candidateTerm: number, localIndex: number, localTerm: number): boolean {
  return candidateTerm > localTerm || (candidateTerm === localTerm && candidateIndex >= localIndex);
}

export function electionTimeoutMs(heartbeatTimeoutMs: number, random = Math.random()): number {
  return Math.floor(heartbeatTimeoutMs * (0.5 + random * 0.5));
}