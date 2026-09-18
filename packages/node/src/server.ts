import type { AddressInfo } from "node:net";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = createApp(config);

app.server.listen(config.port, () => {
  const port = (app.server.address() as AddressInfo).port;
  app.log("server_started", { role: config.role, shard: config.shardId, port });
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log("shutdown_signal_received", { signal });
  await app.shutdownGracefully();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
