import type WebSocket from "ws";
import type { AofEntry } from "../persistence/aof.js";

export interface ReplicationController {
  isLeader(): boolean;
  getCurrentLeaderId(): string;
  getCurrentLeaderUrl(): string;
  getConnectedPeerIds(): string[];
  getLastReplicationLagMs(): number | null;
  // Per-follower ACK lag visible from the leader.  Returns {} when isLeader()
  // is false (callers should guard on isLeader() before displaying this).
  getPerFollowerLagMs(): Record<string, number | null>;
  // Per-follower backpressure flag: true = this follower's send buffer has
  // exceeded the soft threshold and new ops are being held back.
  getPerFollowerLagging(): Record<string, boolean>;
  start(): void;
  stop(): void;
  handleInboundRaw(socket: WebSocket, raw: string): boolean;
  afterLocalWrite(entry: AofEntry): void;
}