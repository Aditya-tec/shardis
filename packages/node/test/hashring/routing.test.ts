import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createApp, type App } from "../../src/app.js";
import type { NodeConfig } from "../../src/config.js";
import { keySlot } from "../../src/hashring/hash.js";

const TWO_SHARD_FIXTURE = fileURLToPath(new URL("../fixtures/cluster.two-shard.json", import.meta.url));

function testConfig(overrides: Partial<NodeConfig>): NodeConfig {
  return {
    // Matches the two-shard fixture's declared shard-a leader id, so this
    // node boots up already believing itself the (sole, peer-less) leader
    // of its shard and can serve local writes without a MOVED "not_leader".
    nodeId: "node-a1",
    role: "leader",
    shardId: "shard-a",
    clusterConfigPath: TWO_SHARD_FIXTURE,
    dataDir: mkdtempSync(join(tmpdir(), "shardis-routing-test-")),
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

async function startApp(overrides: Partial<NodeConfig>): Promise<{ app: App; url: string; dataDir: string }> {
  const config = testConfig(overrides);
  const app = createApp(config);
  await new Promise<void>((resolve) => app.server.listen(0, resolve));
  const port = (app.server.address() as AddressInfo).port;
  return { app, url: `ws://127.0.0.1:${port}/ws`, dataDir: config.dataDir };
}

async function connect(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return socket;
}

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    socket.once("message", (data) => resolve(JSON.parse(data.toString("utf8"))));
  });
}

// The two-shard fixture splits slots [0,8191] -> shard-a and [8192,16383] ->
// shard-b. Rather than hardcoding magic key names, pick keys deterministically
// by probing keySlot() until one lands in each half.
function findKeyForShard(shardId: "shard-a" | "shard-b"): string {
  for (let i = 0; i < 10000; i += 1) {
    const candidate = `probe-${i}`;
    const slot = keySlot(candidate);
    const inShardA = slot <= 8191;
    if ((shardId === "shard-a") === inShardA) return candidate;
  }
  throw new Error(`could not find a probe key for ${shardId}`);
}

describe("MOVED routing across shards", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length) {
      const fn = cleanups.pop()!;
      await fn();
    }
  });

  async function registerApp(overrides: Partial<NodeConfig>) {
    const { app, url, dataDir } = await startApp(overrides);
    cleanups.push(async () => {
      app.wss.close();
      app.close();
      await new Promise<void>((resolve) => app.server.close(() => resolve()));
      rmSync(dataDir, { recursive: true, force: true });
    });
    return { app, url };
  }

  it("a node serves a key that hashes into its own shard's range", async () => {
    const { url } = await registerApp({ shardId: "shard-a" });
    const socket = await connect(url);
    cleanups.push(async () => socket.close());

    const key = findKeyForShard("shard-a");
    socket.send(JSON.stringify({ id: "1", op: "SET", key, value: "v" }));
    expect(await nextMessage(socket)).toEqual({ id: "1", ok: true });
  });

  it("a node redirects with MOVED for a key belonging to the other shard", async () => {
    const { url } = await registerApp({ shardId: "shard-a" });
    const socket = await connect(url);
    cleanups.push(async () => socket.close());

    const key = findKeyForShard("shard-b");
    socket.send(JSON.stringify({ id: "1", op: "GET", key }));
    expect(await nextMessage(socket)).toEqual({
      id: "1",
      ok: false,
      error: "MOVED",
      shard: "shard-b",
      leader: "ws://leader-b.example/ws"
    });
  });

  it("the shard that actually owns a MOVED key serves it directly", async () => {
    const { url: urlA } = await registerApp({ shardId: "shard-a" });
    const { url: urlB } = await registerApp({ shardId: "shard-b", nodeId: "node-b1" });

    const socketA = await connect(urlA);
    const socketB = await connect(urlB);
    cleanups.push(async () => socketA.close());
    cleanups.push(async () => socketB.close());

    const key = findKeyForShard("shard-b");
    socketA.send(JSON.stringify({ id: "1", op: "SET", key, value: "v" }));
    expect(await nextMessage(socketA)).toMatchObject({ ok: false, error: "MOVED", shard: "shard-b" });

    socketB.send(JSON.stringify({ id: "2", op: "SET", key, value: "v" }));
    expect(await nextMessage(socketB)).toEqual({ id: "2", ok: true });
  });

  it("MOVED is returned before any AOF write or store mutation happens", async () => {
    const { app, url } = await registerApp({ shardId: "shard-a" });
    const socket = await connect(url);
    cleanups.push(async () => socket.close());

    const key = findKeyForShard("shard-b");
    socket.send(JSON.stringify({ id: "1", op: "SET", key, value: "v" }));
    await nextMessage(socket);

    expect(app.store.has(key)).toBe(false);
  });
});
