import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const port = () => 33000 + Math.floor(Math.random() * 7000);
const wsUrl = (value: number) => `ws://127.0.0.1:${value}/ws`;

async function connect(target: string): Promise<WebSocket> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const socket = new WebSocket(target);
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      return socket;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`could not connect to ${target}`);
}

function request(socket: WebSocket, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    socket.once("message", (data) => resolve(JSON.parse(data.toString("utf8"))));
    socket.send(JSON.stringify(body));
  });
}

async function waitUntil<T>(fn: () => Promise<T | null>, description: string): Promise<T> {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for: ${description}`);
}

describe("Raft failover", () => {
  let children: ChildProcess[] = [];
  let dataDir = "";
  let configPath = "";

  afterEach(async () => {
    await Promise.all(children.map((child) => new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.kill("SIGKILL"); })));
    children = [];
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    if (configPath) rmSync(configPath, { force: true });
  });

  it("elects one leader, replicates a write, and elects a replacement after SIGKILL", async () => {
    const nodes = [
      { id: "raft-a", port: port() },
      { id: "raft-b", port: port() },
      { id: "raft-c", port: port() }
    ];
    dataDir = mkdtempSync(join(tmpdir(), "shardis-raft-data-"));
    const configDir = mkdtempSync(join(tmpdir(), "shardis-raft-config-"));
    configPath = join(configDir, "cluster.json");
    writeFileSync(configPath, JSON.stringify({ shards: [{ id: "shard-a", hash_range: [0, 16383], leader: { id: nodes[0].id, url: wsUrl(nodes[0].port) }, followers: nodes.slice(1).map((node) => ({ id: node.id, url: wsUrl(node.port) })) }] }));
    const spawnNode = (node: typeof nodes[number]) => spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: packageRoot,
      env: { ...process.env, NODE_ID: node.id, ROLE: "follower", SHARD_ID: "shard-a", FAILOVER_MODE: "raft", PORT: String(node.port), DATA_DIR: join(dataDir, node.id), CLUSTER_CONFIG_PATH: configPath, HEARTBEAT_INTERVAL_MS: "80", HEARTBEAT_TIMEOUT_MS: "300" },
      stdio: "ignore"
    });
    children = nodes.map(spawnNode);

    const elected = await waitUntil(async () => {
      const leaders = [];
      for (const node of nodes) {
        const response = await fetch(`http://127.0.0.1:${node.port}/healthz`).catch(() => null);
        if (response?.ok && (await response.json() as { role: string }).role === "leader") leaders.push(node);
      }
      return leaders.length === 1 ? leaders[0] : null;
    }, "a single Raft leader");
    const leaderSocket = await connect(wsUrl(elected.port));
    expect(await request(leaderSocket, { id: "set", op: "SET", key: "raft-key", value: "raft-value" })).toMatchObject({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 500));

    const leaderIndex = nodes.findIndex((node) => node.id === elected.id);
    const killed = children[leaderIndex];
    children = children.filter((_, index) => index !== leaderIndex);
    leaderSocket.close();
    killed.kill("SIGKILL");
    await new Promise<void>((resolve) => killed.once("exit", () => resolve()));

    const replacement = await waitUntil(async () => {
      for (const node of nodes) {
        if (node.id === elected.id) continue;
        const response = await fetch(`http://127.0.0.1:${node.port}/healthz`).catch(() => null);
        if (response?.ok && (await response.json() as { role: string }).role === "leader") return node;
      }
      return null;
    }, "a replacement Raft leader");
    const replacementSocket = await connect(wsUrl(replacement.port));
    await waitUntil(async () => {
      const response = await request(replacementSocket, { id: "get", op: "GET", key: "raft-key" });
      return response.value === "raft-value" ? response : null;
    }, "committed value on the replacement leader");
    replacementSocket.close();
  }, 60000);
});