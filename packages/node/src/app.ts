import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { NodeConfig } from "./config.js";
import { Store } from "./engine/store.js";
import { loadClusterConfig } from "./hashring/config.js";
import { HashRing } from "./hashring/ring.js";
import { AofLog } from "./persistence/aof.js";
import { applyAofEntries } from "./persistence/replay.js";
import { loadSnapshot, writeSnapshotAtomic } from "./persistence/snapshot.js";
import { entryForRequest } from "./persistence/writer.js";
import { dispatch } from "./protocol/dispatch.js";
import { parseRequest } from "./protocol/parse.js";
import { isStoreRequest, type ErrResponse } from "./protocol/types.js";
import { PubSubBroker, type Subscriber } from "./pubsub/broker.js";
import { dispatchPubSub } from "./pubsub/dispatch.js";
import { ReplicationManager } from "./replication/manager.js";
import { TokenBucket } from "./security/rateLimit.js";
import { writeKeyValid } from "./security/safeCompare.js";

export interface App {
  server: Server;
  wss: WebSocketServer;
  store: Store;
  aofLog: AofLog;
  pubsub: PubSubBroker;
  ring: HashRing;
  replication: ReplicationManager;
  log: (event: string, fields?: Record<string, unknown>) => void;
  snapshotNow: () => void;
  close: () => void;
  // Graceful production shutdown (SIGTERM/SIGINT): stops accepting new
  // writes, closes client connections with a clean WS frame, then tears
  // down timers/replication/AOF. Distinct from close(), which tests use
  // for immediate synchronous teardown without the drain sequence.
  shutdownGracefully: () => Promise<void>;
}

export function createApp(config: NodeConfig, startedAt = Date.now()): App {
  const store = new Store({ maxmemoryBytes: config.maxmemoryMb * 1024 * 1024 });
  const pubsub = new PubSubBroker();
  let opsTotal = 0;

  // Dashboard clients subscribe to this same /ws endpoint (see
  // DASHBOARD_SUBSCRIBE below) and receive every structured log line live,
  // giving the dashboard's event feed real data with no separate pipeline.
  const dashboardListeners = new Set<WebSocket>();
  function log(event: string, fields: Record<string, unknown> = {}): void {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      node_id: config.nodeId,
      level: "info",
      event,
      ...fields
    });
    console.log(line);
    for (const listener of dashboardListeners) {
      if (listener.readyState === listener.OPEN) {
        try {
          listener.send(line);
        } catch {
          // Ignore; the listener's own close handler will drop it from the set.
        }
      }
    }
  }

  const clusterConfig = loadClusterConfig(config.clusterConfigPath);
  const ring = new HashRing(clusterConfig);

  const ownShard = clusterConfig.shards.find((shard) => shard.id === config.shardId);
  if (!ownShard) throw new Error(`SHARD_ID "${config.shardId}" not found in cluster config`);
  const shardPeers = [ownShard.leader, ...ownShard.followers].filter((node) => node.id !== config.nodeId);

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

  const replication = new ReplicationManager({
    nodeId: config.nodeId,
    shardId: config.shardId,
    peers: shardPeers,
    initialLeaderId: ownShard.leader.id,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    heartbeatTimeoutMs: config.heartbeatTimeoutMs,
    store,
    aofLog,
    log,
    onFullSyncApplied: () => snapshotNow()
  });
  replication.start();

  function snapshotNow(): void {
    const entries = store.dump();
    writeSnapshotAtomic(snapshotPath, entries);
    aofLog.truncate();
    log("snapshot_taken", { keys: entries.length });
  }

  const snapshotTimer = setInterval(snapshotNow, config.snapshotIntervalMs);
  snapshotTimer.unref?.();

  store.startSweep(config.ttlSweepIntervalMs);

  let shuttingDown = false;

  const server = createServer((req, res) => {
    // /healthz and /metrics are read-only, non-sensitive status endpoints
    // that the dashboard fetches directly from the browser (a different
    // origin than each node), so they need CORS enabled to be readable
    // there at all. Writes only ever happen over the WS protocol, which
    // isn't subject to the same-origin fetch restriction in the first place.
    if (req.url === "/healthz" || req.url === "/metrics") {
      res.setHeader("Access-Control-Allow-Origin", "*");
    }

    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          node_id: config.nodeId,
          role: replication.isLeader() ? "leader" : "follower",
          shard: config.shardId,
          uptime_s: Math.floor((Date.now() - startedAt) / 1000)
        })
      );
      return;
    }

    if (req.method === "GET" && req.url === "/metrics") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          node_id: config.nodeId,
          role: replication.isLeader() ? "leader" : "follower",
          shard: config.shardId,
          uptime_s: Math.floor((Date.now() - startedAt) / 1000),
          keys: store.size,
          evictions: store.evictions,
          ops_total: opsTotal,
          connected_sockets: wss.clients.size,
          connected_peers: replication.getConnectedPeerIds().length,
          replication_lag_ms: replication.isLeader() ? null : replication.getLastReplicationLagMs()
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

  // Not an env-configurable value (unlike RATE_LIMIT_RPS): this bounds a
  // single connection's own footprint in the broker, not cluster-wide
  // traffic, so a fixed sane ceiling is enough. Without it, a client could
  // SUBSCRIBE to unboundedly many distinct channel names and grow the
  // broker's channel map forever - each new channel name is a new Map
  // entry, not something the existing per-message rate limit bounds.
  const MAX_SUBSCRIPTIONS_PER_CONNECTION = 100;

  wss.on("connection", (socket: WebSocket) => {
    const subscriber: Subscriber = { send: (data: string) => socket.send(data) };
    const subscribedChannels = new Set<string>();

    const rateLimiter = new TokenBucket(config.rateLimitRps, config.rateLimitRps);

    socket.on("message", (data) => {
      // A single bad frame must produce an error response, never take the
      // connection or the process down with it.
      try {
        const raw = data.toString("utf8");
        if (replication.handleInboundRaw(socket, raw)) return;

        if (!rateLimiter.tryConsume()) {
          log("client_rejected", { error: "rate_limited" });
          socket.send(JSON.stringify({ id: null, ok: false, error: "rate_limited" }));
          return;
        }

        if (raw.includes('"DASHBOARD_SUBSCRIBE"')) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = null;
          }
          if (parsed && typeof parsed === "object" && (parsed as Record<string, unknown>).type === "DASHBOARD_SUBSCRIBE") {
            dashboardListeners.add(socket);
            socket.send(JSON.stringify({ type: "DASHBOARD_SUBSCRIBED", node_id: config.nodeId }));
            return;
          }
        }

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

        if (isStoreRequest(result.request)) {
          const isWriteOp = result.request.op !== "GET";
          if (shuttingDown && isWriteOp) {
            socket.send(JSON.stringify({ id: result.request.id, ok: false, error: "shutting_down" }));
            return;
          }

          if (
            config.publicDemo &&
            result.request.op !== "GET" &&
            !writeKeyValid(result.request.write_key, config.demoWriteKey)
          ) {
            log("client_rejected", { error: "write_key_required", op: result.request.op });
            socket.send(JSON.stringify({ id: result.request.id, ok: false, error: "write_key_required" }));
            return;
          }

          const owningShard = ring.shardForKey(result.request.key);
          if (owningShard.id !== config.shardId) {
            log("moved_redirect", { key: result.request.key, shard: owningShard.id });
            socket.send(
              JSON.stringify({
                id: result.request.id,
                ok: false,
                error: "MOVED",
                shard: owningShard.id,
                leader: owningShard.leader.url
              })
            );
            return;
          }

          if (isWriteOp && !replication.isLeader()) {
            log("moved_redirect", { key: result.request.key, shard: config.shardId, reason: "not_leader" });
            socket.send(
              JSON.stringify({
                id: result.request.id,
                ok: false,
                error: "MOVED",
                shard: config.shardId,
                leader: replication.getCurrentLeaderUrl()
              })
            );
            return;
          }

          const aofEntry = entryForRequest(result.request, Date.now);
          if (aofEntry) {
            // Durably persisted before the write is applied or acked, so a
            // crash between here and the ack can never lose it on replay.
            aofLog.append(aofEntry);
          }

          const response = dispatch(result.request, store);
          opsTotal += 1;
          if (isWriteOp) {
            log("write_applied", { op: result.request.op, key: result.request.key });
            if (aofEntry) replication.afterLocalWrite(aofEntry);
          }
          socket.send(JSON.stringify(response));
          return;
        }

        if (
          config.publicDemo &&
          result.request.op === "PUBLISH" &&
          !writeKeyValid(result.request.write_key, config.demoWriteKey)
        ) {
          log("client_rejected", { error: "write_key_required", op: result.request.op });
          socket.send(JSON.stringify({ id: result.request.id, ok: false, error: "write_key_required" }));
          return;
        }

        if (
          result.request.op === "SUBSCRIBE" &&
          !subscribedChannels.has(result.request.channel) &&
          subscribedChannels.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION
        ) {
          log("client_rejected", { error: "too_many_subscriptions" });
          socket.send(JSON.stringify({ id: result.request.id, ok: false, error: "too_many_subscriptions" }));
          return;
        }

        const response = dispatchPubSub(result.request, pubsub, subscriber);
        if (result.request.op === "SUBSCRIBE") subscribedChannels.add(result.request.channel);
        if (result.request.op === "UNSUBSCRIBE") subscribedChannels.delete(result.request.channel);
        log("pubsub_event", { op: result.request.op, channel: result.request.channel });
        socket.send(JSON.stringify(response));
      } catch (error) {
        log("message_handler_error", { error: error instanceof Error ? error.message : String(error) });
        socket.send(JSON.stringify({ id: null, ok: false, error: "internal_error" }));
      }
    });

    socket.on("close", () => {
      pubsub.unsubscribeAll(subscriber);
      dashboardListeners.delete(socket);
    });

    socket.on("error", (error) => {
      log("connection_error", { error: error.message });
    });
  });

  function closeInternal(): void {
    clearInterval(snapshotTimer);
    store.stopSweep();
    replication.stop();
    aofLog.close();
  }

  async function shutdownGracefully(): Promise<void> {
    shuttingDown = true;
    log("shutdown_draining", { connections: wss.clients.size });

    // Stop accepting new connections. Deliberately not awaiting a close
    // callback here: an *upgraded* WebSocket socket is detached from
    // Node's normal HTTP keep-alive tracking, and in practice
    // server.close()'s callback never fires while one is open - we drive
    // completion from draining wss.clients below instead.
    server.close();

    // A brief grace tick before closing each connection: bytes a client
    // already sent can still be sitting unparsed in the socket's read
    // buffer, and closing immediately can abandon them before the message
    // handler (which now correctly rejects writes via shuttingDown, but
    // still serves reads) ever sees them. This lets already-in-flight
    // messages get a real response instead of being silently dropped.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const CLOSE_HANDSHAKE_TIMEOUT_MS = 1000;
    await Promise.all(
      [...wss.clients].map(
        (client) =>
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, CLOSE_HANDSHAKE_TIMEOUT_MS);
            client.once("close", () => {
              clearTimeout(timer);
              resolve();
            });
            client.close(1001, "server shutting down");
          })
      )
    );

    closeInternal();
  }

  return {
    server,
    wss,
    store,
    aofLog,
    pubsub,
    ring,
    replication,
    log,
    snapshotNow,
    close: closeInternal,
    shutdownGracefully
  };
}
