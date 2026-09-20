import { mkdtempSync, rmSync } from "node:fs";
import { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createApp, type App } from "../src/app.js";
import type { NodeConfig } from "../src/config.js";
import { decodeResponse, encodeRequest } from "../src/protocol/binaryCodec.js";
import type { Response } from "../src/protocol/types.js";

const SINGLE_SHARD_FIXTURE = fileURLToPath(new URL("./fixtures/cluster.single-shard.json", import.meta.url));

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
    clusterConfigPath: SINGLE_SHARD_FIXTURE,
    dataDir: tempDataDir(),
    port: 0,
    maxmemoryMb: 64,
    ttlSweepIntervalMs: 1000,
    snapshotIntervalMs: 60000,
    heartbeatIntervalMs: 1000,
    heartbeatTimeoutMs: 3000,
    rateLimitRps: 50,
    maxConnectionsPerIp: 20,
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

function nextBinaryResponse(socket: WebSocket): Promise<Response> {
  return new Promise((resolve) => {
    socket.once("message", (data) => resolve(decodeResponse(data as Buffer)));
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

  it("MAXMEMORY_MB config wires through to real LRU eviction on the running store", async () => {
    // maxmemoryMb: 0 means a 0-byte cap, so the write that just landed is
    // itself immediately over cap and gets evicted straight away - the
    // cheapest way to prove the config value actually reaches Store.
    const { url: tinyUrl, app: tinyApp } = await startApp({ maxmemoryMb: 0 });
    const tinySocket = await connect(tinyUrl);

    tinySocket.send(JSON.stringify({ id: "1", op: "SET", key: "foo", value: "bar" }));
    expect(await nextMessage(tinySocket)).toEqual({ id: "1", ok: true });

    tinySocket.send(JSON.stringify({ id: "2", op: "GET", key: "foo" }));
    expect(await nextMessage(tinySocket)).toEqual({ id: "2", ok: true, value: null });
    expect(tinyApp.store.evictions).toBeGreaterThan(0);

    tinySocket.close();
    tinyApp.wss.close();
    tinyApp.close();
    await new Promise<void>((resolve) => tinyApp.server.close(() => resolve()));
  });

  it("PUBLISH delivers to a SUBSCRIBE'd connection but not to an unrelated one (two concurrent sessions)", async () => {
    const subscriber = await connect(url);
    const bystander = await connect(url);

    subscriber.send(JSON.stringify({ id: "1", op: "SUBSCRIBE", channel: "events" }));
    expect(await nextMessage(subscriber)).toEqual({ id: "1", ok: true, subscribed: true });

    const bystanderMessages: unknown[] = [];
    bystander.on("message", (data) => bystanderMessages.push(JSON.parse(data.toString("utf8"))));

    const pushPromise = nextMessage(subscriber);
    socket.send(JSON.stringify({ id: "2", op: "PUBLISH", channel: "events", message: "hello" }));
    expect(await nextMessage(socket)).toEqual({ id: "2", ok: true, delivered: 1 });
    expect(await pushPromise).toEqual({ type: "MESSAGE", channel: "events", message: "hello" });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(bystanderMessages).toEqual([]);

    subscriber.close();
    bystander.close();
  });

  it("UNSUBSCRIBE stops further delivery to that connection", async () => {
    const subscriber = await connect(url);
    subscriber.send(JSON.stringify({ id: "1", op: "SUBSCRIBE", channel: "events" }));
    await nextMessage(subscriber);

    subscriber.send(JSON.stringify({ id: "2", op: "UNSUBSCRIBE", channel: "events" }));
    expect(await nextMessage(subscriber)).toEqual({ id: "2", ok: true, unsubscribed: true });

    socket.send(JSON.stringify({ id: "3", op: "PUBLISH", channel: "events", message: "hello" }));
    expect(await nextMessage(socket)).toEqual({ id: "3", ok: true, delivered: 0 });

    subscriber.close();
  });

  it("disconnecting a subscriber cleanly drops it from the broker (no leaked listener)", async () => {
    const subscriber = await connect(url);
    subscriber.send(JSON.stringify({ id: "1", op: "SUBSCRIBE", channel: "events" }));
    await nextMessage(subscriber);
    expect(app.pubsub.channelSubscriberCount("events")).toBe(1);

    subscriber.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(app.pubsub.channelSubscriberCount("events")).toBe(0);
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

  it("healthz/metrics allow cross-origin reads so the dashboard (a different origin) can fetch them", async () => {
    const port = (app.server.address() as AddressInfo).port;
    const healthz = await fetch(`http://127.0.0.1:${port}/healthz`);
    const metrics = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(healthz.headers.get("access-control-allow-origin")).toBe("*");
    expect(metrics.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("GET /metrics reports live counters that change as the store is used", async () => {
    const port = (app.server.address() as AddressInfo).port;

    const before = await (await fetch(`http://127.0.0.1:${port}/metrics`)).json();
    expect(before).toMatchObject({
      node_id: "node-test",
      role: "leader",
      shard: "shard-a",
      keys: 0,
      evictions: 0,
      ops_total: 0,
      connected_peers: 0,
      replication_lag_ms: null
    });
    expect(before.connected_sockets).toBeGreaterThanOrEqual(1); // our own test socket

    socket.send(JSON.stringify({ id: "1", op: "SET", key: "foo", value: "bar" }));
    await nextMessage(socket);
    socket.send(JSON.stringify({ id: "2", op: "GET", key: "foo" }));
    await nextMessage(socket);

    const after = await (await fetch(`http://127.0.0.1:${port}/metrics`)).json();
    expect(after.keys).toBe(1);
    expect(after.ops_total).toBe(2);
  });

  it("protects administrative routes and exports a durable snapshot when CLUSTER_SECRET is set", async () => {
    const { app: secureApp } = await startApp({ clusterSecret: "admin-secret" });
    const port = (secureApp.server.address() as AddressInfo).port;
    try {
      const denied = await fetch(`http://127.0.0.1:${port}/admin/snapshot`, { method: "POST" });
      expect(denied.status).toBe(401);

      secureApp.store.set("backed-up", "value");
      const allowed = await fetch(`http://127.0.0.1:${port}/admin/snapshot`, {
        method: "POST",
        headers: { "x-shardis-admin-token": "admin-secret" }
      });
      expect(allowed.status).toBe(200);
      expect(await allowed.json()).toMatchObject({ node_id: "node-test", entries: [{ key: "backed-up", value: "value" }] });
    } finally {
      secureApp.wss.close();
      secureApp.close();
      await new Promise<void>((resolve) => secureApp.server.close(() => resolve()));
    }
  });

  it("DASHBOARD_SUBSCRIBE streams every subsequent log event live to that connection", async () => {
    socket.send(JSON.stringify({ type: "DASHBOARD_SUBSCRIBE" }));
    expect(await nextMessage(socket)).toEqual({ type: "DASHBOARD_SUBSCRIBED", node_id: "node-test" });

    const eventPromise = nextMessage(socket);
    const other = await connect(url);
    other.send(JSON.stringify({ id: "1", op: "SET", key: "watched", value: "v" }));
    await nextMessage(other);
    other.close();

    const event = (await eventPromise) as Record<string, unknown>;
    expect(event).toMatchObject({ event: "write_applied", op: "SET", key: "watched" });
  });

  it("PUBLIC_DEMO rejects writes without a matching write_key, but leaves GET/SUBSCRIBE open", async () => {
    const { url: demoUrl, app: demoApp } = await startApp({ publicDemo: true, demoWriteKey: "secret123" });
    const demoSocket = await connect(demoUrl);

    demoSocket.send(JSON.stringify({ id: "1", op: "SET", key: "foo", value: "bar" }));
    expect(await nextMessage(demoSocket)).toEqual({ id: "1", ok: false, error: "write_key_required" });

    demoSocket.send(JSON.stringify({ id: "2", op: "SET", key: "foo", value: "bar", write_key: "wrong" }));
    expect(await nextMessage(demoSocket)).toEqual({ id: "2", ok: false, error: "write_key_required" });

    demoSocket.send(JSON.stringify({ id: "3", op: "SET", key: "foo", value: "bar", write_key: "secret123" }));
    expect(await nextMessage(demoSocket)).toEqual({ id: "3", ok: true });

    // GET and SUBSCRIBE stay open with no write_key at all.
    demoSocket.send(JSON.stringify({ id: "4", op: "GET", key: "foo" }));
    expect(await nextMessage(demoSocket)).toEqual({ id: "4", ok: true, value: "bar" });
    demoSocket.send(JSON.stringify({ id: "5", op: "SUBSCRIBE", channel: "c" }));
    expect(await nextMessage(demoSocket)).toEqual({ id: "5", ok: true, subscribed: true });

    // PUBLISH is treated as a write and gated too.
    demoSocket.send(JSON.stringify({ id: "6", op: "PUBLISH", channel: "c", message: "hi" }));
    expect(await nextMessage(demoSocket)).toEqual({ id: "6", ok: false, error: "write_key_required" });

    demoSocket.close();
    demoApp.wss.close();
    demoApp.close();
    await new Promise<void>((resolve) => demoApp.server.close(() => resolve()));
  });

  it("PUBLIC_DEMO with no DEMO_WRITE_KEY configured fails closed (rejects every write, not just none required)", async () => {
    const { url: demoUrl, app: demoApp } = await startApp({ publicDemo: true, demoWriteKey: undefined });
    const demoSocket = await connect(demoUrl);

    demoSocket.send(JSON.stringify({ id: "1", op: "SET", key: "foo", value: "bar" }));
    expect(await nextMessage(demoSocket)).toEqual({ id: "1", ok: false, error: "write_key_required" });

    // Even an empty-string write_key must not accidentally satisfy an
    // undefined expected key.
    demoSocket.send(JSON.stringify({ id: "2", op: "SET", key: "foo", value: "bar", write_key: "" }));
    expect(await nextMessage(demoSocket)).toEqual({ id: "2", ok: false, error: "write_key_required" });

    demoSocket.close();
    demoApp.wss.close();
    demoApp.close();
    await new Promise<void>((resolve) => demoApp.server.close(() => resolve()));
  });

  it("caps the number of distinct channels a single connection can SUBSCRIBE to", async () => {
    // A high rateLimitRps here so this test isolates the subscription cap
    // from the (separately tested) per-connection rate limit.
    const { url: capUrl, app: capApp } = await startApp({ rateLimitRps: 1000 });
    const capSocket = await connect(capUrl);

    for (let i = 0; i < 100; i += 1) {
      capSocket.send(JSON.stringify({ id: `${i}`, op: "SUBSCRIBE", channel: `channel-${i}` }));
      expect(await nextMessage(capSocket)).toEqual({ id: `${i}`, ok: true, subscribed: true });
    }

    capSocket.send(JSON.stringify({ id: "over", op: "SUBSCRIBE", channel: "channel-100" }));
    expect(await nextMessage(capSocket)).toEqual({ id: "over", ok: false, error: "too_many_subscriptions" });

    // Re-subscribing to an already-subscribed channel isn't a *new*
    // subscription, so it must not be blocked by the cap.
    capSocket.send(JSON.stringify({ id: "resub", op: "SUBSCRIBE", channel: "channel-0" }));
    expect(await nextMessage(capSocket)).toEqual({ id: "resub", ok: true, subscribed: true });

    // Freeing a slot via UNSUBSCRIBE allows a new channel again.
    capSocket.send(JSON.stringify({ id: "un", op: "UNSUBSCRIBE", channel: "channel-1" }));
    await nextMessage(capSocket);
    capSocket.send(JSON.stringify({ id: "new", op: "SUBSCRIBE", channel: "channel-101" }));
    expect(await nextMessage(capSocket)).toEqual({ id: "new", ok: true, subscribed: true });

    capSocket.close();
    capApp.wss.close();
    capApp.close();
    await new Promise<void>((resolve) => capApp.server.close(() => resolve()));
  }, 15000);

  it("MAX_CONNECTIONS_PER_IP config caps concurrent connections from one address", async () => {
    // Set limit to 2 so we can test rejection without opening many sockets.
    const { url: capUrl, app: capApp } = await startApp({ maxConnectionsPerIp: 2 });
    const sockets: WebSocket[] = [];
    try {
      // First two connections are allowed.
      for (let i = 0; i < 2; i++) {
        sockets.push(await connect(capUrl));
      }
      // Third connection from the same IP (127.0.0.1) must be rejected.
      const rejected = new WebSocket(capUrl);
      await new Promise<void>((resolve, reject) => {
        rejected.once("close", (code) => {
          expect(code).toBe(1013);
          resolve();
        });
        rejected.once("error", () => resolve()); // ws may error before close
        setTimeout(reject, 2000);
      });
    } finally {
      for (const s of sockets) s.close();
      capApp.wss.close();
      capApp.close();
      await new Promise<void>((resolve) => capApp.server.close(() => resolve()));
    }
  });

  it("without PUBLIC_DEMO, writes succeed with no write_key at all (local/CI stay open)", async () => {
    socket.send(JSON.stringify({ id: "1", op: "SET", key: "foo", value: "bar" }));
    expect(await nextMessage(socket)).toEqual({ id: "1", ok: true });
  });

  it("per-connection rate limiting rejects a burst over RATE_LIMIT_RPS without crashing the connection", async () => {
    const { url: limitedUrl, app: limitedApp } = await startApp({ rateLimitRps: 3 });
    const limitedSocket = await connect(limitedUrl);

    const responses: Record<string, unknown>[] = [];
    for (let i = 0; i < 5; i += 1) {
      limitedSocket.send(JSON.stringify({ id: `${i}`, op: "GET", key: "x" }));
      responses.push((await nextMessage(limitedSocket)) as Record<string, unknown>);
    }

    const rejected = responses.filter((r) => r.error === "rate_limited");
    const accepted = responses.filter((r) => r.ok === true);
    expect(rejected.length).toBeGreaterThan(0);
    expect(accepted.length).toBeGreaterThan(0);
    expect(rejected[0]).toEqual({ id: null, ok: false, error: "rate_limited" });

    // The connection survives being rate-limited and keeps working afterward.
    await new Promise((resolve) => setTimeout(resolve, 400));
    limitedSocket.send(JSON.stringify({ id: "after-wait", op: "GET", key: "x" }));
    expect(await nextMessage(limitedSocket)).toEqual({ id: "after-wait", ok: true, value: null });

    limitedSocket.close();
    limitedApp.wss.close();
    limitedApp.close();
    await new Promise<void>((resolve) => limitedApp.server.close(() => resolve()));
  });

  it("accepts a real binary WS frame and replies binary (opt-in wire format)", async () => {
    socket.send(encodeRequest({ id: "1", op: "SET", key: "foo", value: "bar" }));
    expect(await nextBinaryResponse(socket)).toEqual({ id: "1", ok: true });

    socket.send(encodeRequest({ id: "2", op: "GET", key: "foo" }));
    expect(await nextBinaryResponse(socket)).toEqual({ id: "2", ok: true, value: "bar" });
  });

  it("binary and text frames interleave correctly on the same connection", async () => {
    socket.send(encodeRequest({ id: "1", op: "SET", key: "a", value: "1" }));
    expect(await nextBinaryResponse(socket)).toEqual({ id: "1", ok: true });

    socket.send(JSON.stringify({ id: "2", op: "SET", key: "b", value: "2" }));
    expect(await nextMessage(socket)).toEqual({ id: "2", ok: true });

    socket.send(encodeRequest({ id: "3", op: "GET", key: "b" }));
    expect(await nextBinaryResponse(socket)).toEqual({ id: "3", ok: true, value: "2" });
  });

  it("a malformed binary frame gets a clean binary error, not a crash", async () => {
    socket.send(Buffer.from([255, 0, 0, 0, 99])); // unknown opcode, bogus id length
    const response = await nextBinaryResponse(socket);
    expect(response.ok).toBe(false);

    // Connection survives; still works afterward.
    socket.send(encodeRequest({ id: "after", op: "GET", key: "x" }));
    expect(await nextBinaryResponse(socket)).toEqual({ id: "after", ok: true, value: null });
  });

});
