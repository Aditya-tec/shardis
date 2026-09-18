import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { decodeResponse, encodeRequest } from "../../node/dist/protocol/binaryCodec.js";
import type { Request } from "../../node/dist/protocol/types.js";

export interface ShardisRequest {
  op: string;
  key?: string;
  value?: string;
  ttl_ms?: number;
  channel?: string;
  message?: string;
  write_key?: string;
}

export interface ShardisResponse {
  id?: string | null;
  ok: boolean;
  [key: string]: unknown;
}

const MAX_MOVED_HOPS = 5;

export class ShardisClient {
  private socket: WebSocket | null = null;
  private url: string;
  private readonly binary: boolean;
  private readonly pending = new Map<string, (response: ShardisResponse) => void>();
  private readonly onPush?: (message: ShardisResponse) => void;

  constructor(url: string, onPush?: (message: ShardisResponse) => void, binary = false) {
    this.url = url;
    this.onPush = onPush;
    this.binary = binary;
  }

  get currentUrl(): string {
    return this.url;
  }

  async connect(): Promise<void> {
    const socket = new WebSocket(this.url);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    socket.on("message", (data, isBinary) => this.handleMessage(data, isBinary));
  }

  async reconnect(url: string): Promise<void> {
    this.close();
    this.url = url;
    await this.connect();
  }

  close(): void {
    this.socket?.removeAllListeners();
    this.socket?.close();
    this.socket = null;
  }

  async send(request: ShardisRequest, hops = 0): Promise<ShardisResponse> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("not connected");
    }

    const id = randomUUID();
    const socket = this.socket;
    const response = await new Promise<ShardisResponse>((resolve) => {
      this.pending.set(id, resolve);
      if (this.binary) {
        socket.send(encodeRequest({ id, ...request } as Request));
      } else {
        socket.send(JSON.stringify({ id, ...request }));
      }
    });

    if (!response.ok && response.error === "MOVED" && typeof response.leader === "string") {
      if (hops >= MAX_MOVED_HOPS) {
        throw new Error(`too many MOVED redirects, last target: ${response.leader}`);
      }
      await this.reconnect(response.leader);
      return this.send(request, hops + 1);
    }

    return response;
  }

  private handleMessage(data: WebSocket.RawData, isBinary: boolean): void {
    let parsed: ShardisResponse;
    try {
      if (isBinary) {
        const buffer = Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]);
        parsed = decodeResponse(buffer) as ShardisResponse;
      } else {
        parsed = JSON.parse(data.toString("utf8"));
      }
    } catch {
      return;
    }

    const id = typeof parsed.id === "string" ? parsed.id : undefined;
    const resolve = id ? this.pending.get(id) : undefined;
    if (id && resolve) {
      this.pending.delete(id);
      resolve(parsed);
      return;
    }

    this.onPush?.(parsed);
  }
}
