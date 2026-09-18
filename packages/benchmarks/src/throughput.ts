import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { connectWithRetry, killAndWait, nodeUrl, randomPort, spawnNode } from "./lib/cluster.js";
import { appendBenchmarkRow } from "./lib/report.js";

const CLIENTS = Number(process.env.BENCH_CLIENTS ?? 20);
const DURATION_S = Number(process.env.BENCH_DURATION_S ?? 10);

async function runClient(socket: WebSocket, clientId: number, stopAt: number): Promise<number> {
  let ops = 0;
  let i = 0;
  while (Date.now() < stopAt) {
    const key = `bench-${clientId}-${i % 500}`;
    const isWrite = i % 2 === 0;
    const request = isWrite
      ? { id: `${clientId}-${i}`, op: "SET", key, value: `v${i}` }
      : { id: `${clientId}-${i}`, op: "GET", key };
    await new Promise<void>((resolve) => {
      socket.once("message", () => resolve());
      socket.send(JSON.stringify(request));
    });
    ops += 1;
    i += 1;
  }
  return ops;
}

async function main(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "shardis-bench-throughput-"));
  const configDir = mkdtempSync(join(tmpdir(), "shardis-bench-throughput-config-"));
  const clusterConfigPath = join(configDir, "cluster.json");
  const port = randomPort();

  writeFileSync(
    clusterConfigPath,
    JSON.stringify({
      shards: [
        {
          id: "shard-a",
          hash_range: [0, 16383],
          leader: { id: "node-bench", url: nodeUrl(port) },
          followers: []
        }
      ]
    })
  );

  const child = spawnNode({ id: "node-bench", port, shardId: "shard-a" }, clusterConfigPath, dataDir, {
    MAXMEMORY_MB: "256"
  });

  try {
    const sockets = await Promise.all(Array.from({ length: CLIENTS }, () => connectWithRetry(nodeUrl(port))));

    console.log(`Running ${CLIENTS} concurrent clients for ${DURATION_S}s...`);
    const stopAt = Date.now() + DURATION_S * 1000;
    const started = Date.now();
    const results = await Promise.all(sockets.map((socket, i) => runClient(socket, i, stopAt)));
    const elapsedS = (Date.now() - started) / 1000;

    for (const socket of sockets) socket.close();

    const totalOps = results.reduce((a, b) => a + b, 0);
    const opsPerSec = Math.round(totalOps / elapsedS);

    console.log(`Total ops: ${totalOps} in ${elapsedS.toFixed(2)}s => ${opsPerSec} ops/sec`);

    appendBenchmarkRow(
      "Throughput",
      ["Clients", "Duration (s)", "Total ops", "Ops/sec"],
      [CLIENTS, elapsedS.toFixed(2), totalOps, opsPerSec]
    );
  } finally {
    await killAndWait(child);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
