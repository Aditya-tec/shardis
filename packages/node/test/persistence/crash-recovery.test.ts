import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const clusterConfigPath = fileURLToPath(new URL("../fixtures/cluster.single-shard.json", import.meta.url));

function randomPort(): number {
  return 21000 + Math.floor(Math.random() * 20000);
}

function spawnNode(port: number, dataDir: string, envOverrides: Record<string, string> = {}): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: packageRoot,
    env: {
      ...process.env,
      NODE_ID: "node-crash-test",
      ROLE: "leader",
      SHARD_ID: "shard-a",
      PORT: String(port),
      DATA_DIR: dataDir,
      CLUSTER_CONFIG_PATH: clusterConfigPath,
      ...envOverrides
    },
    stdio: "ignore"
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, description: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for: ${description}`);
}

async function connectWithRetry(url: string, attempts = 40): Promise<WebSocket> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const socket = new WebSocket(url);
      await new Promise<void>((resolve, reject) => {
        socket.once("open", () => resolve());
        socket.once("error", reject);
      });
      return socket;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw new Error(`could not connect to ${url}: ${String(lastError)}`);
}

function send(socket: WebSocket, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    socket.once("message", (data) => resolve(JSON.parse(data.toString("utf8"))));
    socket.send(JSON.stringify(request));
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

function checksumOf(values: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

describe("AOF crash recovery (hard kill + restart)", () => {
  let child: ChildProcess | null = null;
  let dataDir = "";

  afterEach(async () => {
    if (child) {
      child.kill("SIGKILL");
      await waitForExit(child);
      child = null;
    }
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("recovers a byte-identical state after SIGKILL and restart on the same data dir", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "shardis-crash-"));
    const port = randomPort();

    child = spawnNode(port, dataDir);
    const socket = await connectWithRetry(`ws://127.0.0.1:${port}/ws`);

    const keys = Array.from({ length: 25 }, (_, i) => `key-${i}`);
    for (const key of keys) {
      const response = await send(socket, { id: key, op: "SET", key, value: `value-for-${key}` });
      expect(response.ok).toBe(true);
    }
    // One key with a long-lived ttl, to prove ttl survives the restart too.
    await send(socket, { id: "ttl-set", op: "SET", key: "with-ttl", value: "v", ttl_ms: 5 * 60_000 });
    keys.push("with-ttl");

    const before: Record<string, unknown> = {};
    for (const key of keys) {
      before[key] = (await send(socket, { id: `get-${key}`, op: "GET", key })).value;
    }
    const beforeChecksum = checksumOf(before);

    socket.close();
    child.kill("SIGKILL");
    await waitForExit(child);
    child = null;

    child = spawnNode(port, dataDir);
    const socket2 = await connectWithRetry(`ws://127.0.0.1:${port}/ws`);

    const after: Record<string, unknown> = {};
    for (const key of keys) {
      after[key] = (await send(socket2, { id: `get2-${key}`, op: "GET", key })).value;
    }
    const afterChecksum = checksumOf(after);
    socket2.close();

    expect(afterChecksum).toBe(beforeChecksum);
    expect(after).toEqual(before);
  }, 30000);

  it("recovers snapshot state plus the post-snapshot AOF tail after a hard kill", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "shardis-crash-snapshot-"));
    const port = randomPort();
    const snapshotPath = join(dataDir, "snapshot.json");
    const aofPath = join(dataDir, "aof.log");

    // A short interval so the periodic snapshot fires deterministically
    // within the test instead of relying on the production default.
    child = spawnNode(port, dataDir, { SNAPSHOT_INTERVAL_MS: "200" });
    const socket = await connectWithRetry(`ws://127.0.0.1:${port}/ws`);

    const beforeSnapshotKeys = Array.from({ length: 10 }, (_, i) => `pre-${i}`);
    for (const key of beforeSnapshotKeys) {
      await send(socket, { id: key, op: "SET", key, value: `${key}-value` });
    }

    await waitUntil(() => existsSync(snapshotPath), 5000, "snapshot.json to be written");
    // The AOF is truncated in the same synchronous pass as the snapshot
    // write, so once the snapshot exists the tail holds only what comes next.

    const afterSnapshotKeys = Array.from({ length: 5 }, (_, i) => `post-${i}`);
    for (const key of afterSnapshotKeys) {
      await send(socket, { id: key, op: "SET", key, value: `${key}-value` });
    }

    const allKeys = [...beforeSnapshotKeys, ...afterSnapshotKeys];
    const before: Record<string, unknown> = {};
    for (const key of allKeys) {
      before[key] = (await send(socket, { id: `get-${key}`, op: "GET", key })).value;
    }

    expect(existsSync(aofPath)).toBe(true);

    socket.close();
    child.kill("SIGKILL");
    await waitForExit(child);
    child = null;

    child = spawnNode(port, dataDir, { SNAPSHOT_INTERVAL_MS: "200" });
    const socket2 = await connectWithRetry(`ws://127.0.0.1:${port}/ws`);

    const after: Record<string, unknown> = {};
    for (const key of allKeys) {
      after[key] = (await send(socket2, { id: `get2-${key}`, op: "GET", key })).value;
    }
    socket2.close();

    expect(after).toEqual(before);
    expect(after["pre-0"]).toBe("pre-0-value");
    expect(after["post-0"]).toBe("post-0-value");
  }, 30000);
});
