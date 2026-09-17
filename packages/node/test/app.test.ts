import { mkdtempSync, rmSync } from "node:fs";
import { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createApp, type App } from "../src/app.js";
import type { NodeConfig } from "../src/config.js";

const dataDirs: string[] = [];

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "shardis-app-test-"));
  dataDirs.push(dir);
  return dir;
}

function testConfig(overrides: Partial<NodeConfig> = {}): NodeConfig {
  return {
    nodeId: "node-test",
    role: "leader",
    shardId: "shard-a",
    clusterConfigPath: "./cluster.config.local.json",
    dataDir: tempDataDir(),
    port: 0,
    maxmemoryMb: 64,
    ttlSweepIntervalMs: 1000,
    snapshotIntervalMs: 60000,
    heartbeatIntervalMs: 1000,
    heartbeatTimeoutMs: 3000,
    rateLimitRps: 50,
    maxKeyBytes: 1024,
    maxValueBytes: 65536,
    publicDemo: false,
    demoWriteKey: undefined,
    ...overrides
  };
}

async function startApp(overrides: Partial<NodeConfig> = {}): Promise<{ app: App; url: string }> {
  const app = createApp(testConfig(overrides));
  await new Promise<void>((resolve) => app.server.listen(0, resolve));
  const port = (app.server.address() as AddressInfo).port;
  return { app, url: `ws://127.0.0.1:${port}/ws` };
}

async function connect(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return socket;
}

function nextMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve) => {
    socket.once("message", (data) => resolve(JSON.parse(data.toString("utf8"))));
  });
}

describe("app WS protocol", () => {
  let app: App;
  let url: string;
  let socket: WebSocket;

  beforeEach(async () => {
    ({ app, url } = await startApp());
    socket = await connect(url);
  });

  afterEach(async () => {
    socket.close();
    app.wss.close();
    app.close();
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
    while (dataDirs.length) {
      rmSync(dataDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("round-trips SET then GET over the wire", async () => {
    socket.send(JSON.stringify({ id: "1", op: "SET", key: "foo", value: "bar" }));
    expect(await nextMessage(socket)).toEqual({ id: "1", ok: true });

    socket.send(JSON.stringify({ id: "2", op: "GET", key: "foo" }));
    expect(await nextMessage(socket)).toEqual({ id: "2", ok: true, value: "bar" });
  });

  it("returns a clean error for malformed JSON and keeps the connection alive", async () => {
    socket.send("{not valid json");
    expect(await nextMessage(socket)).toEqual({ id: null, ok: false, error: "malformed_json" });

    socket.send(JSON.stringify({ id: "3", op: "GET", key: "still-works" }));
    expect(await nextMessage(socket)).toEqual({ id: "3", ok: true, value: null });
  });

  it("rejects an oversized value without crashing the connection", async () => {
    const { url: smallLimitUrl, app: smallApp } = await startApp({ maxValueBytes: 8 });
    const smallSocket = await connect(smallLimitUrl);

    smallSocket.send(JSON.stringify({ id: "1", op: "SET", key: "foo", value: "way-too-long-for-the-limit" }));
    expect(await nextMessage(smallSocket)).toEqual({ id: "1", ok: false, error: "value_too_large" });

    smallSocket.send(JSON.stringify({ id: "2", op: "SET", key: "foo", value: "ok" }));
    expect(await nextMessage(smallSocket)).toEqual({ id: "2", ok: true });

    smallSocket.close();
    smallApp.wss.close();
    smallApp.close();
    await new Promise<void>((resolve) => smallApp.server.close(() => resolve()));
  });

  it("a second connection is unaffected by malformed input on the first", async () => {
    const other = await connect(url);

    socket.send("garbage");
    expect(await nextMessage(socket)).toMatchObject({ ok: false });

    other.send(JSON.stringify({ id: "1", op: "SET", key: "shared", value: "v" }));
    expect(await nextMessage(other)).toEqual({ id: "1", ok: true });

    other.close();
  });

  it("GET /healthz reports node identity and role", async () => {
    const port = (app.server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ status: "ok", node_id: "node-test", role: "leader", shard: "shard-a" });
  });
});
