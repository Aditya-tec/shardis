import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { connectWithRetry, killAndWait, nodeUrl, randomPort, send, spawnNode } from "./lib/cluster.js";
import { appendBenchmarkRow } from "./lib/report.js";

const ITERATIONS = Number(process.env.BENCH_REPL_LAG_ITERATIONS ?? 50);

async function pollUntilVisible(socket: WebSocket, key: string, expected: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await send(socket, { id: `poll-${key}`, op: "GET", key });
    if (response.value === expected) return Date.now();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${key} to replicate`);
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function main(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "shardis-bench-lag-"));
  const configDir = mkdtempSync(join(tmpdir(), "shardis-bench-lag-config-"));
  const clusterConfigPath = join(configDir, "cluster.json");

  const leaderSpec = { id: "node-a1", port: randomPort(), shardId: "shard-a" };
  const followerSpec = { id: "node-a2", port: randomPort(), shardId: "shard-a" };

  writeFileSync(
    clusterConfigPath,
    JSON.stringify({
      shards: [
        {
          id: "shard-a",
          hash_range: [0, 16383],
          leader: { id: leaderSpec.id, url: nodeUrl(leaderSpec.port) },
          followers: [{ id: followerSpec.id, url: nodeUrl(followerSpec.port) }]
        }
      ]
    })
  );

  const leader = spawnNode(leaderSpec, clusterConfigPath, dataDir);
  const follower = spawnNode(followerSpec, clusterConfigPath, dataDir);

  try {
    const leaderSocket = await connectWithRetry(nodeUrl(leaderSpec.port));
    const followerSocket = await connectWithRetry(nodeUrl(followerSpec.port));

    // Let the peer mesh + initial full sync settle before measuring.
    await send(leaderSocket, { id: "warmup", op: "SET", key: "warmup", value: "v" });
    await pollUntilVisible(followerSocket, "warmup", "v", 5000);

    const lags: number[] = [];
    console.log(`Measuring replication lag over ${ITERATIONS} writes...`);
    for (let i = 0; i < ITERATIONS; i += 1) {
      const key = `lag-key-${i}`;
      const value = `v-${i}-${Date.now()}`;
      const t0 = Date.now();
      await send(leaderSocket, { id: `w-${i}`, op: "SET", key, value });
      const t1 = await pollUntilVisible(followerSocket, key, value, 5000);
      lags.push(t1 - t0);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    leaderSocket.close();
    followerSocket.close();

    const sorted = [...lags].sort((a, b) => a - b);
    const avg = lags.reduce((a, b) => a + b, 0) / lags.length;
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const p50 = percentile(sorted, 50);
    const p95 = percentile(sorted, 95);

    console.log(`avg=${avg.toFixed(1)}ms min=${min}ms p50=${p50}ms p95=${p95}ms max=${max}ms`);

    appendBenchmarkRow(
      "Replication lag",
      ["Samples", "Avg (ms)", "p50 (ms)", "p95 (ms)", "Min (ms)", "Max (ms)"],
      [ITERATIONS, avg.toFixed(1), p50, p95, min, max]
    );
  } finally {
    await killAndWait(leader);
    await killAndWait(follower);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
