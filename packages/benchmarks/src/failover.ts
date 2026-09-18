import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChildProcess } from "node:child_process";
import { connectWithRetry, fetchJson, killAndWait, nodeUrl, randomPort, send, spawnNode, waitUntil } from "./lib/cluster.js";
import { appendBenchmarkRow } from "./lib/report.js";

// Production-realistic defaults (matching .env.example), not sped up, so
// this number reflects what a real deployment would actually see.
const HEARTBEAT_INTERVAL_MS = process.env.BENCH_HEARTBEAT_INTERVAL_MS ?? "1000";
const HEARTBEAT_TIMEOUT_MS = process.env.BENCH_HEARTBEAT_TIMEOUT_MS ?? "3000";

async function main(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "shardis-bench-failover-"));
  const configDir = mkdtempSync(join(tmpdir(), "shardis-bench-failover-config-"));
  const clusterConfigPath = join(configDir, "cluster.json");

  const leaderSpec = { id: "node-a1", port: randomPort(), shardId: "shard-a" };
  const followerLowSpec = { id: "node-a2", port: randomPort(), shardId: "shard-a" };
  const followerHighSpec = { id: "node-a3", port: randomPort(), shardId: "shard-a" };

  writeFileSync(
    clusterConfigPath,
    JSON.stringify({
      shards: [
        {
          id: "shard-a",
          hash_range: [0, 16383],
          leader: { id: leaderSpec.id, url: nodeUrl(leaderSpec.port) },
          followers: [
            { id: followerLowSpec.id, url: nodeUrl(followerLowSpec.port) },
            { id: followerHighSpec.id, url: nodeUrl(followerHighSpec.port) }
          ]
        }
      ]
    })
  );

  const envOverrides = { HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS };
  let leader: ChildProcess | null = spawnNode(leaderSpec, clusterConfigPath, dataDir, envOverrides);
  const followerLow = spawnNode(followerLowSpec, clusterConfigPath, dataDir, envOverrides);
  const followerHigh = spawnNode(followerHighSpec, clusterConfigPath, dataDir, envOverrides);

  try {
    const leaderSocket = await connectWithRetry(nodeUrl(leaderSpec.port));
    await send(leaderSocket, { id: "seed", op: "SET", key: "warmup", value: "v" });
    leaderSocket.close();

    console.log(`Killing leader (${leaderSpec.id}), heartbeat_timeout=${HEARTBEAT_TIMEOUT_MS}ms...`);
    const t0 = Date.now();
    await killAndWait(leader);
    leader = null;

    await waitUntil(
      async () => ((await fetchJson(`http://127.0.0.1:${followerLowSpec.port}/healthz`))?.role === "leader" ? true : null),
      15000,
      "a follower to be promoted"
    );
    const t1 = Date.now();
    const promotionMs = t1 - t0;
    console.log(`Promotion detected after ${promotionMs}ms`);

    const promotedSocket = await connectWithRetry(nodeUrl(followerLowSpec.port));
    await send(promotedSocket, { id: "post-failover", op: "SET", key: "post-failover-key", value: "v" });
    const t2 = Date.now();
    promotedSocket.close();

    const firstWriteMs = t2 - t1;
    const totalRecoveryMs = t2 - t0;
    console.log(`First accepted write after promotion: +${firstWriteMs}ms (total recovery: ${totalRecoveryMs}ms)`);

    appendBenchmarkRow(
      "Failover",
      ["Heartbeat timeout (ms)", "Promotion time (ms)", "First write after promotion (ms)", "Total recovery (ms)"],
      [HEARTBEAT_TIMEOUT_MS, promotionMs, firstWriteMs, totalRecoveryMs]
    );
  } finally {
    if (leader) await killAndWait(leader);
    await killAndWait(followerLow);
    await killAndWait(followerHigh);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
