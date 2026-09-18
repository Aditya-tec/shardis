import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

function port(): number {
  return 30000 + Math.floor(Math.random() * 8000);
}

function url(value: number): string {
  return `ws://127.0.0.1:${value}/ws`;
}

async function connect(target: string): Promise<WebSocket> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const socket = new WebSocket(target);
      await new Promise<void>((resolve, reject) => {
        socket.once("open", () => resolve());
        socket.once("error", reject);
      });
      return socket;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`could not connect to ${target}`);
}

function send(socket: WebSocket, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    socket.once("message", (data) => resolve(JSON.parse(data.toString("utf8"))));
    socket.send(JSON.stringify(request));
  });
}

async function waitUntil<T>(fn: () => Promise<T | null>, description: string): Promise<T> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for: ${description}`);
}

describe("dynamic follower membership", () => {
  let children: ChildProcess[] = [];
  let dataDir = "";
  let configPath = "";

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
    if (configPath) rmSync(configPath, { force: true });
  });

  it("joins using only JOIN_URL and receives writes through the relayed membership", async () => {
    const leaderPort = port();
    const followerPort = port();
    const joinerPort = port();
    dataDir = mkdtempSync(join(tmpdir(), "shardis-membership-data-"));
    const configDir = mkdtempSync(join(tmpdir(), "shardis-membership-config-"));
    configPath = join(configDir, "cluster.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        shards: [
          {
            id: "shard-a",
            hash_range: [0, 16383],
            leader: { id: "node-a1", url: url(leaderPort) },
            followers: [{ id: "node-a2", url: url(followerPort) }]
          }
        ]
      })
    );

    const spawnNode = (id: string, nodePort: number, extra: Record<string, string> = {}): ChildProcess =>
      spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
        cwd: packageRoot,
        env: {
          ...process.env,
          NODE_ID: id,
          ROLE: id === "node-a1" ? "leader" : "follower",
          SHARD_ID: "shard-a",
          PORT: String(nodePort),
          DATA_DIR: join(dataDir, id),
          CLUSTER_CONFIG_PATH: configPath,
          HEARTBEAT_INTERVAL_MS: "100",
          HEARTBEAT_TIMEOUT_MS: "350",
          ...extra
        },
        stdio: "ignore"
      });

    children = [
      spawnNode("node-a1", leaderPort),
      spawnNode("node-a2", followerPort),
      spawnNode("node-a3", joinerPort, { JOIN_URL: url(leaderPort), NODE_URL: url(joinerPort) })
    ];

    const leader = await connect(url(leaderPort));
    const joiner = await connect(url(joinerPort));
    await waitUntil(
      async () => {
        const response = await fetch(`http://127.0.0.1:${joinerPort}/metrics`);
        if (!response.ok) return null;
        const metrics = await response.json() as { connected_peers: number };
        return metrics.connected_peers >= 2 ? metrics : null;
      },
      "joiner to connect to the shard members"
    );

    expect(await send(leader, { id: "1", op: "SET", key: "joined-key", value: "joined-value" })).toEqual({ id: "1", ok: true });
    await waitUntil(
      async () => {
        const response = await send(joiner, { id: "check", op: "GET", key: "joined-key" });
        return response.value === "joined-value" ? response : null;
      },
      "replication to reach the dynamically joined follower"
    );

    const followerMetrics = await fetch(`http://127.0.0.1:${followerPort}/metrics`).then((response) => response.json()) as { connected_peers: number };
    expect(followerMetrics.connected_peers).toBeGreaterThanOrEqual(2);
    leader.close();
    joiner.close();
  }, 45000);
});