import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createApp, type App } from "../../src/app.js";
import type { NodeConfig } from "../../src/config.js";

const SINGLE_SHARD_FIXTURE = fileURLToPath(new URL("../fixtures/cluster.single-shard.json", import.meta.url));

// child.kill("SIGTERM") on Windows force-terminates a child process without
// ever invoking its SIGTERM handler (verified empirically: no real signal
// delivery to child processes on this platform), so a real "spawn, send
// SIGTERM, observe a clean exit" test can't run faithfully here. This
// exercises app.shutdownGracefully() directly instead - the exact function
// server.ts's SIGTERM/SIGINT handler calls - against a real listening
// server, real AOF files, and real WebSocket clients. The literal
// spawn+SIGTERM+restart scenario is additionally verified against a real
// Linux container in the Docker Compose step, where signal delivery is
// faithful to production (Render also sends a real SIGTERM).

function tempDataDir(dirs: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "shardis-shutdown-test-"));
  dirs.push(dir);
  return dir;
}

function testConfig(dataDir: string, overrides: Partial<NodeConfig> = {}): NodeConfig {
  return {
    nodeId: "node-test",
    role: "leader",
    shardId: "shard-a",
    clusterConfigPath: SINGLE_SHARD_FIXTURE,
    dataDir,
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

async function listen(app: App): Promise<string> {
  await new Promise<void>((resolve) => app.server.listen(0, resolve));
  const port = (app.server.address() as AddressInfo).port;
  return `ws://127.0.0.1:${port}/ws`;
}

// Correlates responses to requests by id so multiple sends can be in
// flight concurrently on one socket without racing each other - a bare
// socket.once("message", ...) per send doesn't work here: any single
// incoming message satisfies *every* currently-pending once-listener at
// once, misattributing responses and leaving later ones unresolved.
async function connect(url: string): Promise<{ socket: WebSocket; send: (request: Record<string, unknown>) => Promise<Record<string, unknown>> }> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });

  const pending = new Map<string, (response: Record<string, unknown>) => void>();
  socket.on("message", (data) => {
    const response = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
    const id = typeof response.id === "string" ? response.id : undefined;
    const resolve = id ? pending.get(id) : undefined;
    if (id && resolve) {
      pending.delete(id);
      resolve(response);
    }
  });

  const send = (request: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const id = request.id as string;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      socket.send(JSON.stringify(request));
    });
  };

  return { socket, send };
}

describe("graceful shutdown", () => {
  const dataDirs: string[] = [];

  afterEach(() => {
    while (dataDirs.length) rmSync(dataDirs.pop()!, { recursive: true, force: true });
  });

  it("drains a write burst with zero data loss, then restarts against the same data dir", async () => {
    const dataDir = tempDataDir(dataDirs);
    const app = createApp(testConfig(dataDir));
    const url = await listen(app);
    const { socket, send } = await connect(url);

    const keys = Array.from({ length: 15 }, (_, i) => `burst-${i}`);
    // Fire the whole burst without awaiting each response, then start the
    // graceful shutdown concurrently - some writes will land before the
    // shuttingDown flag flips, some after; both are acceptable outcomes as
    // long as every request resolves cleanly and none is lost or corrupted.
    const responsePromises = keys.map((key) => send({ id: key, op: "SET", key, value: `${key}-value` }));

    const closeEventCode = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
    const shutdownPromise = app.shutdownGracefully();

    const responses = await Promise.all(responsePromises);
    const acceptedKeys = keys.filter((_, i) => (responses[i] as { ok: boolean }).ok === true);
    const rejectedKeys = keys.filter((_, i) => (responses[i] as { ok: boolean }).ok === false);

    for (const response of responses) {
      const typed = response as { ok: boolean; error?: string };
      expect(typed.ok === true || typed.error === "shutting_down").toBe(true);
    }

    expect(await closeEventCode).toBe(1001);
    await shutdownPromise;

    // Restart: a fresh App over the same data dir stands in for the process
    // restart a real "kill and relaunch" would do.
    const restarted = createApp(testConfig(dataDir));
    for (const key of acceptedKeys) {
      expect(restarted.store.get(key)).toBe(`${key}-value`);
    }
    for (const key of rejectedKeys) {
      expect(restarted.store.get(key)).toBeUndefined();
    }
    restarted.close();
  });

  it("rejects a write on a still-open connection once shutdown has begun, without crashing it", async () => {
    const dataDir = tempDataDir(dataDirs);
    const app = createApp(testConfig(dataDir));
    const url = await listen(app);
    const { send } = await connect(url);

    const shutdownPromise = app.shutdownGracefully();
    const response = await send({ id: "late", op: "SET", key: "late-key", value: "v" });
    expect(response).toEqual({ id: "late", ok: false, error: "shutting_down" });

    await shutdownPromise;
  });

  it("still serves GET requests normally while draining (only writes are rejected)", async () => {
    const dataDir = tempDataDir(dataDirs);
    const app = createApp(testConfig(dataDir));
    const url = await listen(app);
    const { send } = await connect(url);

    await send({ id: "seed", op: "SET", key: "existing", value: "v" });

    const shutdownPromise = app.shutdownGracefully();
    const response = await send({ id: "read", op: "GET", key: "existing" });
    expect(response).toEqual({ id: "read", ok: true, value: "v" });

    await shutdownPromise;
  });

  it("closes idle connections with a clean WS close frame (code 1001)", async () => {
    const dataDir = tempDataDir(dataDirs);
    const app = createApp(testConfig(dataDir));
    const url = await listen(app);
    const { socket } = await connect(url);

    const closeEvent = new Promise<{ code: number }>((resolve) => {
      socket.once("close", (code) => resolve({ code }));
    });

    await app.shutdownGracefully();
    expect((await closeEvent).code).toBe(1001);
  });
});
