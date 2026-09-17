import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const { server, log } = createApp(config);

server.listen(config.port, () => {
  log("server_started", { role: config.role, shard: config.shardId, port: config.port });
});

function shutdown(signal: string) {
  log("shutdown_signal_received", { signal });
  server.close(() => process.exit(0));
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
