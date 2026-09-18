import type WebSocket from "ws";
import type { AofEntry } from "../persistence/aof.js";

export interface ReplicationController {
  isLeader(): boolean;
  getCurrentLeaderId(): string;
  getCurrentLeaderUrl(): string;
  getConnectedPeerIds(): string[];
  getLastReplicationLagMs(): number | null;
  start(): void;
  stop(): void;
  handleInboundRaw(socket: WebSocket, raw: string): boolean;
  afterLocalWrite(entry: AofEntry): void;
}