import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { NodeConfig } from "./config.js";
import { Store } from "./engine/store.js";
import { AofLog } from "./persistence/aof.js";
import { applyAofEntries } from "./persistence/replay.js";
import { loadSnapshot, writeSnapshotAtomic } from "./persistence/snapshot.js";
import { entryForRequest } from "./persistence/writer.js";
import { dispatch } from "./protocol/dispatch.js";
import { parseRequest } from "./protocol/parse.js";
import type { ErrResponse } from "./protocol/types.js";

export interface App {
  server: Server;
  wss: WebSocketServer;
  store: Store;
  aofLog: AofLog;
  log: (event: string, fields?: Record<string, unknown>) => void;
  snapshotNow: () => void;
  close: () => void;
}

function makeLogger(nodeId: string) {
  return (event: string, fields: Record<string, unknown> = {}) => {
    console.log(
      JSON.stringify({ ts: new Date().toISOString(), node_id: nodeId, level: "info", event, ...fields })
    );
  };
}

export function createApp(config: NodeConfig, startedAt = Date.now()): App {
  const store = new Store({ maxmemoryBytes: config.maxmemoryMb * 1024 * 1024 });
  const log = makeLogger(config.nodeId);

  const snapshotPath = join(config.dataDir, "snapshot.json");
  const snapshot = loadSnapshot(snapshotPath);
  if (snapshot) {
    for (const entry of snapshot) store.restoreSet(entry.key, entry.value, entry.expiresAt);
    log("snapshot_loaded", { entries: snapshot.length });
  }

  const aofLog = new AofLog(join(config.dataDir, "aof.log"));
  aofLog.open();
  // The AOF only ever holds writes since the last snapshot (it's truncated
  // on every snapshot below), so replaying it on top of the loaded snapshot
  // reconstructs exactly snapshot-state + tail, never double-applies.
  const replayed = aofLog.replay();
  applyAofEntries(store, replayed);
  if (replayed.length > 0) {
    log("aof_replayed", { entries: replayed.length, keys: store.size });
  }

  function snapshotNow(): void {
    const entries = store.dump();
    writeSnapshotAtomic(snapshotPath, entries);
    aofLog.truncate();
    log("snapshot_taken", { keys: entries.length });
  }

  const snapshotTimer = setInterval(snapshotNow, config.snapshotIntervalMs);
  snapshotTimer.unref?.();

  store.startSweep(config.ttlSweepIntervalMs);

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

  const wss = new WebSocketServer({
    server,
    path: "/ws",
    maxPayload: config.maxKeyBytes + config.maxValueBytes + 4096
  });

  wss.on("connection", (socket: WebSocket) => {
    socket.on("message", (data) => {
      // A single bad frame must produce an error response, never take the
      // connection or the process down with it.
      try {
        const raw = data.toString("utf8");
        const result = parseRequest(raw, {
          maxKeyBytes: config.maxKeyBytes,
          maxValueBytes: config.maxValueBytes
        });

        if (!result.ok) {
          const response: ErrResponse = result.response;
          log("client_rejected", { error: response.error });
          socket.send(JSON.stringify(response));
          return;
        }

        const aofEntry = entryForRequest(result.request, Date.now);
        if (aofEntry) {
          // Durably persisted before the write is applied or acked, so a
          // crash between here and the ack can never lose it on replay.
          aofLog.append(aofEntry);
        }

        const response = dispatch(result.request, store);
        if (result.request.op !== "GET") {
          log("write_applied", { op: result.request.op, key: result.request.key });
        }
        socket.send(JSON.stringify(response));
      } catch (error) {
        log("message_handler_error", { error: error instanceof Error ? error.message : String(error) });
        socket.send(JSON.stringify({ id: null, ok: false, error: "internal_error" }));
      }
    });

    socket.on("error", (error) => {
      log("connection_error", { error: error.message });
    });
  });

  return {
    server,
    wss,
    store,
    aofLog,
    log,
    snapshotNow,
    close: () => {
      clearInterval(snapshotTimer);
      store.stopSweep();
      aofLog.close();
    }
  };
}
