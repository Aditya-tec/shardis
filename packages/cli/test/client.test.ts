import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { ShardisClient } from "../src/client.js";

interface FakeServer {
  wss: WebSocketServer;
  url: string;
  close: () => Promise<void>;
}

async function fakeServer(handler: (msg: Record<string, unknown>) => Record<string, unknown>): Promise<FakeServer> {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  wss.on("connection", (socket) => {
    socket.on("message", (data) => {
      const msg = JSON.parse(data.toString("utf8"));
      socket.send(JSON.stringify(handler(msg)));
    });
  });
  const port = (wss.address() as AddressInfo).port;
  return {
    wss,
    url: `ws://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => wss.close(() => resolve()))
  };
}

async function binaryFakeServer(handler: (msg: Buffer) => Buffer): Promise<FakeServer> {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  wss.on("connection", (socket) => {
    socket.on("message", (data) => socket.send(handler(Buffer.from(data))));
  });
  const port = (wss.address() as AddressInfo).port;
  return {
    wss,
    url: `ws://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => wss.close(() => resolve()))
  };
}

describe("ShardisClient", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length) {
      const fn = cleanup.pop()!;
      await fn();
    }
  });

  it("sends a request and resolves with the matching response by id", async () => {
    const server = await fakeServer((msg) => ({ id: msg.id, ok: true, value: "bar" }));
    cleanup.push(server.close);

    const client = new ShardisClient(server.url);
    await client.connect();
    cleanup.push(async () => client.close());

    const response = await client.send({ op: "GET", key: "foo" });
    expect(response).toEqual({ id: expect.any(String), ok: true, value: "bar" });
  });

  it("round-trips requests and responses in binary mode", async () => {
    const { decodeRequest, encodeResponse } = await import("../../node/dist/protocol/binaryCodec.js");
    const server = await binaryFakeServer((data) => {
      const decoded = decodeRequest(data, { maxKeyBytes: 1024, maxValueBytes: 1024 });
      if (!decoded.ok) throw new Error(decoded.response.error);
      return encodeResponse({ id: decoded.request.id, ok: true, value: "bar" });
    });
    cleanup.push(server.close);

    const client = new ShardisClient(server.url, undefined, true);
    await client.connect();
    cleanup.push(async () => client.close());

    const response = await client.send({ op: "GET", key: "foo" });
    expect(response).toEqual({ id: expect.any(String), ok: true, value: "bar" });
  });

  it("auto-follows a MOVED response to the new leader and retries there", async () => {
    const leader = await fakeServer((msg) => ({ id: msg.id, ok: true, value: "from-leader" }));
    cleanup.push(leader.close);

    const stale = await fakeServer((msg) => ({
      id: msg.id,
      ok: false,
      error: "MOVED",
      shard: "shard-b",
      leader: leader.url
    }));
    cleanup.push(stale.close);

    const client = new ShardisClient(stale.url);
    await client.connect();
    cleanup.push(async () => client.close());

    const response = await client.send({ op: "GET", key: "foo" });
    expect(response).toEqual({ id: expect.any(String), ok: true, value: "from-leader" });
    expect(client.currentUrl).toBe(leader.url);
  });

  it("throws after too many MOVED hops instead of looping forever", async () => {
    let url = "";
    const server = await fakeServer((msg) => ({
      id: msg.id,
      ok: false,
      error: "MOVED",
      shard: "shard-a",
      leader: url
    }));
    url = server.url;
    cleanup.push(server.close);

    const client = new ShardisClient(server.url);
    await client.connect();
    cleanup.push(async () => client.close());

    await expect(client.send({ op: "GET", key: "foo" })).rejects.toThrow(/too many MOVED redirects/);
  });

  it("routes unsolicited pushes (no matching pending id) to the onPush callback", async () => {
    const server = await fakeServer(() => ({}));
    cleanup.push(server.close);

    const pushes: unknown[] = [];
    const client = new ShardisClient(server.url, (msg) => pushes.push(msg));
    await client.connect();
    cleanup.push(async () => client.close());

    server.wss.clients.forEach((socket) => socket.send(JSON.stringify({ type: "REPL_OP", seq: 1 })));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(pushes).toEqual([{ type: "REPL_OP", seq: 1 }]);
  });
});
