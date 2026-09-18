import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { WebSocketServer } from "ws";
import { sendConsoleRequest } from "./wsRequest";

// Vitest runs in Node, while the dashboard helper uses the browser's global
// WebSocket API. Use the same ws implementation as the fake test servers.
globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;

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

describe("sendConsoleRequest", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length) {
      const fn = cleanup.pop()!;
      await fn();
    }
  });

  it("returns the response directly when no MOVED redirect is needed", async () => {
    const server = await fakeServer((msg) => ({ id: msg.id, ok: true, value: "bar" }));
    cleanup.push(server.close);

    const result = await sendConsoleRequest(server.url, { op: "GET", key: "foo" });

    expect(result.response).toEqual({ id: expect.any(String), ok: true, value: "bar" });
    expect(result.respondedByUrl).toBe(server.url);
    expect(result.followedMoved).toBe(false);
  });

  it("follows exactly one MOVED hop to the leader and reports it", async () => {
    const leader = await fakeServer((msg) => ({ id: msg.id, ok: true }));
    cleanup.push(leader.close);

    const stale = await fakeServer((msg) => ({ id: msg.id, ok: false, error: "MOVED", shard: "shard-b", leader: leader.url }));
    cleanup.push(stale.close);

    const result = await sendConsoleRequest(stale.url, { op: "SET", key: "foo", value: "bar" });

    expect(result.response).toEqual({ id: expect.any(String), ok: true });
    expect(result.respondedByUrl).toBe(leader.url);
    expect(result.followedMoved).toBe(true);
  });

  it("does not follow a MOVED-shaped response missing a leader field", async () => {
    const server = await fakeServer((msg) => ({ id: msg.id, ok: false, error: "MOVED", shard: "shard-b" }));
    cleanup.push(server.close);

    const result = await sendConsoleRequest(server.url, { op: "GET", key: "foo" });

    expect(result.followedMoved).toBe(false);
    expect(result.response).toMatchObject({ ok: false, error: "MOVED" });
  });

  it("rejects if the initial connection cannot be established", async () => {
    await expect(sendConsoleRequest("ws://127.0.0.1:1", { op: "GET", key: "foo" }, 500)).rejects.toThrow();
  });
});
