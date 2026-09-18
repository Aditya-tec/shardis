import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

// packages/node must be built (pnpm --filter @shardis/node build) before
// running any benchmark - these spawn the same dist/server.js the Docker
// image runs, exactly like the node package's own integration tests do.
export const NODE_PACKAGE_ROOT = fileURLToPath(new URL("../../../node", import.meta.url));

export interface NodeSpec {
  id: string;
  port: number;
  shardId: string;
}

export function randomPort(): number {
  return 28000 + Math.floor(Math.random() * 15000);
}

export function nodeUrl(port: number): string {
  return `ws://127.0.0.1:${port}/ws`;
}

export function spawnNode(
  spec: NodeSpec,
  clusterConfigPath: string,
  dataDir: string,
  envOverrides: Record<string, string> = {}
): ChildProcess {
  return spawn(process.execPath, ["dist/server.js"], {
    cwd: NODE_PACKAGE_ROOT,
    env: {
      ...process.env,
      NODE_ID: spec.id,
      SHARD_ID: spec.shardId,
      PORT: String(spec.port),
      DATA_DIR: `${dataDir}/${spec.id}`,
      CLUSTER_CONFIG_PATH: clusterConfigPath,
      ...envOverrides
    },
    stdio: "ignore"
  });
}

export async function connectWithRetry(url: string, attempts = 50, delayMs = 150): Promise<WebSocket> {
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
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(`could not connect to ${url}: ${String(lastError)}`);
}

export function send(socket: WebSocket, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    socket.once("message", (data) => resolve(JSON.parse(data.toString("utf8"))));
    socket.send(JSON.stringify(request));
  });
}

export async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function waitUntil<T>(fn: () => Promise<T | null>, timeoutMs: number, description: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result !== null) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for: ${description}`);
}

export async function killAndWait(child: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill(signal);
  });
}
