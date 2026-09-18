import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { keySlot } from "../../src/hashring/hash.js";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

interface NodeSpec {
  id: string;
  shard: string;
  port: number;
}

function randomPort(): number {
  return 27000 + Math.floor(Math.random() * 10000);
}

function url(port: number): string {
  return `ws://127.0.0.1:${port}/ws`;
}

function spawnNode(spec: NodeSpec, clusterConfigPath: string, dataDir: string): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: packageRoot,
    env: {
      ...process.env,
      NODE_ID: spec.id,
      SHARD_ID: spec.shard,
      PORT: String(spec.port),
      DATA_DIR: join(dataDir, spec.id),
      CLUSTER_CONFIG_PATH: clusterConfigPath,
      HEARTBEAT_INTERVAL_MS: "100",
      HEARTBEAT_TIMEOUT_MS: "350"
    },
    stdio: "ignore"
  });
}

async function connectWithRetry(target: string): Promise<WebSocket> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const socket = new WebSocket(target);
      await new Promise<void>((resolve, reject) => {
        socket.once("open", () => resolve());
        socket.once("error", reject);
      });
      return socket;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`could not connect to ${target}: ${String(lastError)}`);
}

function request(socket: WebSocket, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    socket.once("message", (data) => resolve(JSON.parse(data.toString("utf8"))));
    socket.send(JSON.stringify(body));
  });
}

async function waitUntil<T>(fn: () => Promise<T | null>, description: string): Promise<T> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for: ${description}`);
}

describe("cross-shard leader gossip", () => {
  let children: ChildProcess[] = [];
  let dataDir = "";
  let clusterConfigPath = "";

  afterEach(async () => {
    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve) => {
            child.once("exit", () => resolve());
            child.kill("SIGKILL");
          })
      )
    );
    children = [];
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    if (clusterConfigPath) rmSync(clusterConfigPath, { force: true });
  });

  it("updates a cross-shard MOVED target after the other shard fails over", async () => {
    const a1: NodeSpec = { id: "node-a1", shard: "shard-a", port: randomPort() };
    const a2: NodeSpec = { id: "node-a2", shard: "shard-a", port: randomPort() };
    const b1: NodeSpec = { id: "node-b1", shard: "shard-b", port: randomPort() };
    const b2: NodeSpec = { id: "node-b2", shard: "shard-b", port: randomPort() };

    dataDir = mkdtempSync(join(tmpdir(), "shardis-gossip-data-"));
    const configDir = mkdtempSync(join(tmpdir(), "shardis-gossip-config-"));
    clusterConfigPath = join(configDir, "cluster.json");
    writeFileSync(
      clusterConfigPath,
      JSON.stringify({
        shards: [
          {
            id: "shard-a",
            hash_range: [0, 8191],
            leader: { id: a1.id, url: url(a1.port) },
            followers: [{ id: a2.id, url: url(a2.port) }]
          },
          {
            id: "shard-b",
            hash_range: [8192, 16383],
            leader: { id: b1.id, url: url(b1.port) },
            followers: [{ id: b2.id, url: url(b2.port) }]
          }
        ]
      })
    );

    children = [a1, a2, b1, b2].map((spec) => spawnNode(spec, clusterConfigPath, dataDir));
    const a1Socket = await connectWithRetry(url(a1.port));
    const b2Socket = await connectWithRetry(url(b2.port));
    const key = Array.from({ length: 1000 }, (_, index) => `cross-shard-${index}`).find((candidate) => keySlot(candidate) <= 8191)!;

    a1Socket.close();
    const killedLeader = children[0];
    children = children.slice(1);
    killedLeader.kill("SIGKILL");
    await new Promise<void>((resolve) => killedLeader.once("exit", () => resolve()));

    await waitUntil(
      async () => {
        const response = await fetch(`http://127.0.0.1:${a2.port}/healthz`);
        return response.ok && (await response.json() as { role: string }).role === "leader" ? true : null;
      },
      "shard-a follower promotion"
    );

    const moved = await waitUntil(
      async () => {
        const response = await request(b2Socket, { id: "moved", op: "GET", key });
        return response.leader === url(a2.port) ? response : null;
      },
      "cross-shard MOVED to the promoted leader"
    );
    expect(moved).toMatchObject({ ok: false, error: "MOVED", shard: "shard-a", leader: url(a2.port) });
    b2Socket.close();
  }, 45000);
});