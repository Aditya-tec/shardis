import type { AddressInfo } from "node:net";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = createApp(config);

app.server.listen(config.port, () => {
  const port = (app.server.address() as AddressInfo).port;
  app.log("server_started", { role: config.role, shard: config.shardId, port });
});

function shutdown(signal: string) {
  app.log("shutdown_signal_received", { signal });
  app.server.close(() => {
    app.close();
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
