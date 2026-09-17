import { createServer } from "node:http";
import { loadConfig } from "./config.js";

const config = loadConfig();
const startedAt = Date.now();

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        node_id: config.nodeId,
        role: config.role,
        shard: config.shardId,
        uptime_s: Math.floor((Date.now() - startedAt) / 1000)
      })
    );
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

server.listen(config.port, () => {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      node_id: config.nodeId,
      level: "info",
      event: "server_started",
      role: config.role,
      shard: config.shardId,
      port: config.port
    })
  );
});

function shutdown(signal: string) {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      node_id: config.nodeId,
      level: "info",
      event: "shutdown_signal_received",
      signal
    })
  );
  server.close(() => process.exit(0));
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
