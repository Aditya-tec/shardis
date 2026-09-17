import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

function randomPort(): number {
  return 24000 + Math.floor(Math.random() * 15000);
}

function nodeUrl(port: number): string {
  return `ws://127.0.0.1:${port}/ws`;
}

interface NodeSpec {
  id: string;
  port: number;
}

function spawnNode(spec: NodeSpec, clusterConfigPath: string, dataDir: string): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: packageRoot,
    env: {
      ...process.env,
      NODE_ID: spec.id,
      SHARD_ID: "shard-a",
      PORT: String(spec.port),
      DATA_DIR: join(dataDir, spec.id),
      CLUSTER_CONFIG_PATH: clusterConfigPath,
      HEARTBEAT_INTERVAL_MS: "100",
      HEARTBEAT_TIMEOUT_MS: "350"
    },
    stdio: "ignore"
  });
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

async function healthz(port: number): Promise<{ status: string; role: string; shard: string } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    if (!res.ok) return null;
    return (await res.json()) as { status: string; role: string; shard: string };
  } catch {
    return null;
  }
}

async function waitUntil<T>(fn: () => Promise<T | null>, timeoutMs: number, description: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for: ${description}`);
}

describe("replication + heartbeat-based failover (real 3-node shard)", () => {
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

  it("replicates writes to followers, then fails over to the lowest-id live follower when the leader is killed", async () => {
    // Lexicographic order matters: node-a1 (leader) < node-a2 < node-a3, so
    // deterministic promotion after node-a1 dies must pick node-a2.
    const leader: NodeSpec = { id: "node-a1", port: randomPort() };
    const followerLow: NodeSpec = { id: "node-a2", port: randomPort() };
    const followerHigh: NodeSpec = { id: "node-a3", port: randomPort() };

    dataDir = mkdtempSync(join(tmpdir(), "shardis-failover-data-"));
    const configDir = mkdtempSync(join(tmpdir(), "shardis-failover-config-"));
    clusterConfigPath = join(configDir, "cluster.json");
    writeFileSync(
      clusterConfigPath,
      JSON.stringify({
        shards: [
          {
            id: "shard-a",
            hash_range: [0, 16383],
            leader: { id: leader.id, url: nodeUrl(leader.port) },
            followers: [
              { id: followerLow.id, url: nodeUrl(followerLow.port) },
              { id: followerHigh.id, url: nodeUrl(followerHigh.port) }
            ]
          }
        ]
      })
    );

    children = [
      spawnNode(leader, clusterConfigPath, dataDir),
      spawnNode(followerLow, clusterConfigPath, dataDir),
      spawnNode(followerHigh, clusterConfigPath, dataDir)
    ];

    const leaderSocket = await connectWithRetry(nodeUrl(leader.port));
    await connectWithRetry(nodeUrl(followerLow.port)).then((s) => s.close());
    await connectWithRetry(nodeUrl(followerHigh.port)).then((s) => s.close());

    // Confirm each node reports the role its shard config assigns at boot.
    await waitUntil(async () => ((await healthz(leader.port))?.role === "leader" ? true : null), 5000, "leader role");

    expect(await send(leaderSocket, { id: "1", op: "SET", key: "foo", value: "bar" })).toEqual({ id: "1", ok: true });
    expect(await send(leaderSocket, { id: "2", op: "SET", key: "baz", value: "qux" })).toEqual({ id: "2", ok: true });

    // Wait for real replication to land on both followers before killing the leader.
    const followerLowSocket = await waitUntil(
      async () => {
        const socket = await connectWithRetry(nodeUrl(followerLow.port));
        const response = await send(socket, { id: "check", op: "GET", key: "baz" });
        if (response.value === "qux") return socket;
        socket.close();
        return null;
      },
      5000,
      "replication to reach node-a2"
    );

    const followerHighSocket = await waitUntil(
      async () => {
        const socket = await connectWithRetry(nodeUrl(followerHigh.port));
        const response = await send(socket, { id: "check", op: "GET", key: "baz" });
        if (response.value === "qux") return socket;
        socket.close();
        return null;
      },
      5000,
      "replication to reach node-a3"
    );

    leaderSocket.close();
    const dyingLeader = children[0];
    children = children.slice(1);
    dyingLeader.kill("SIGKILL");
    await new Promise<void>((resolve) => dyingLeader.once("exit", () => resolve()));

    // Deterministic promotion must pick node-a2 (the lowest-id live follower).
    await waitUntil(
      async () => ((await healthz(followerLow.port))?.role === "leader" ? true : null),
      5000,
      "node-a2 to be promoted to leader"
    );

    const promotedResponse = await send(followerLowSocket, { id: "3", op: "SET", key: "post-failover", value: "v" });
    expect(promotedResponse).toEqual({ id: "3", ok: true });

    // node-a3 must learn of the new leader at runtime (not the stale static
    // config leader, node-a1) and redirect writes there via MOVED.
    const staleWriteResponse = await send(followerHighSocket, {
      id: "4",
      op: "SET",
      key: "should-redirect",
      value: "v"
    });
    expect(staleWriteResponse).toMatchObject({
      ok: false,
      error: "MOVED",
      shard: "shard-a",
      leader: nodeUrl(followerLow.port)
    });

    // And the new leader's write should still reach node-a3 via replication.
    const replicatedAfterFailover = await waitUntil(
      async () => {
        const response = await send(followerHighSocket, { id: "check2", op: "GET", key: "post-failover" });
        return response.value === "v" ? true : null;
      },
      5000,
      "post-failover write to replicate to node-a3"
    );
    expect(replicatedAfterFailover).toBe(true);

    followerLowSocket.close();
    followerHighSocket.close();
  }, 45000);
});
