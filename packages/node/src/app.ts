import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { NodeConfig } from "./config.js";
import { Store } from "./engine/store.js";
import { loadClusterConfig } from "./hashring/config.js";
import { HashRing } from "./hashring/ring.js";
import { keySlot } from "./hashring/hash.js";
import { AofLog } from "./persistence/aof.js";
import { applyAofEntries } from "./persistence/replay.js";
import { loadSnapshot, writeSnapshotAtomic } from "./persistence/snapshot.js";
import { entryForRequest } from "./persistence/writer.js";
import { decodeRequest, encodeResponse } from "./protocol/binaryCodec.js";
import { dispatch } from "./protocol/dispatch.js";
import { parseRequest } from "./protocol/parse.js";
import { isStoreRequest, type ErrResponse, type Response } from "./protocol/types.js";
import { PubSubBroker, type Subscriber } from "./pubsub/broker.js";
import { dispatchPubSub } from "./pubsub/dispatch.js";
import { RaftManager } from "./raft/raftManager.js";
import type { ReplicationController } from "./replication/controller.js";
import { ClusterGossip } from "./gossip/clusterGossip.js";
import { ReplicationManager } from "./replication/manager.js";
import { TokenBucket } from "./security/rateLimit.js";
import { safeCompare, writeKeyValid } from "./security/safeCompare.js";
import { randomUUID } from "node:crypto";

export interface App {
  server: Server;
  wss: WebSocketServer;
  store: Store;
  aofLog: AofLog;
  pubsub: PubSubBroker;
  ring: HashRing;
  replication: ReplicationController;
  clusterGossip: ClusterGossip;
  log: (event: string, fields?: Record<string, unknown>) => void;
  snapshotNow: () => void;
  close: () => void;
  // Graceful production shutdown (SIGTERM/SIGINT): stops accepting new
  // writes, closes client connections with a clean WS frame, then tears
  // down timers/replication/AOF. Distinct from close(), which tests use
  // for immediate synchronous teardown without the drain sequence.
  shutdownGracefully: () => Promise<void>;
  // Admin: migrate a slot from this shard to another. Only valid when this
  // node is the leader of the slot's current owner. Returns the number of
  // keys transferred.
  migrateSlot: (slot: number, toShardId: string) => Promise<{ transferred: number }>;
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
  const clusterGossip = new ClusterGossip({
    nodeId: config.nodeId,
    shards: clusterConfig.shards,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    log,
    clusterSecret: config.clusterSecret,
    slotStatePath: join(config.dataDir, "slot-state.json"),
    onPublishRelay: (channel, message) => pubsub.publish(channel, message)
  });

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

  const replication: ReplicationController = config.failoverMode === "raft"
    ? new RaftManager({
        nodeId: config.nodeId,
        shardId: config.shardId,
        peers: shardPeers,
        heartbeatIntervalMs: config.heartbeatIntervalMs,
        heartbeatTimeoutMs: config.heartbeatTimeoutMs,
        store,
        aofLog,
        log,
        statePath: join(config.dataDir, "raft-state.json"),
        onLeaderChanged: (leaderId) => clusterGossip.announceOwnShardLeader(config.shardId, leaderId)
      })
    : new ReplicationManager({
        nodeId: config.nodeId,
        shardId: config.shardId,
        peers: shardPeers,
        initialLeaderId: ownShard.leader.id,
        heartbeatIntervalMs: config.heartbeatIntervalMs,
        heartbeatTimeoutMs: config.heartbeatTimeoutMs,
        store,
        aofLog,
        nodeUrl: config.nodeUrl ?? `ws://127.0.0.1:${config.port}/ws`,
        joinUrl: config.joinUrl,
        log,
        clusterSecret: config.clusterSecret,
        onFullSyncApplied: () => snapshotNow(),
        onLeaderChanged: (leaderId) => clusterGossip.announceOwnShardLeader(config.shardId, leaderId)
      });
  clusterGossip.start();
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
    if (req.url === "/healthz" || req.url === "/metrics" || req.url === "/topology") {
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
          replication_lag_ms: replication.isLeader() ? null : replication.getLastReplicationLagMs(),
          per_follower_lag_ms: replication.isLeader() ? replication.getPerFollowerLagMs() : null,
          per_follower_lagging: replication.isLeader() ? replication.getPerFollowerLagging() : null
        })
      );
      return;
    }

    // GET /topology — returns the static cluster config this node was started
    // with. Used by the dashboard for dynamic topology discovery.
    if (req.method === "GET" && req.url === "/topology") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(clusterConfig));
      return;
    }

    // Administrative endpoints are intentionally open for local development
    // when CLUSTER_SECRET is unset. Any deployment that sets the cluster
    // secret must present it in this header as well, preventing public users
    // from initiating migration, injecting a slot, or exporting a snapshot.
    const isAdminRoute = req.url?.startsWith("/admin/") ?? false;
    if (isAdminRoute && config.clusterSecret) {
      const provided = req.headers["x-shardis-admin-token"];
      const token = Array.isArray(provided) ? provided[0] : provided;
      if (!safeCompare(token, config.clusterSecret)) {
        log("admin_rejected", { route: req.url });
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "admin_unauthorized" }));
        return;
      }
    }

    // POST /admin/snapshot — force a durable snapshot and return its current
    // entries for an authenticated backup job. This avoids copying a live AOF
    // while preserving the exact snapshot format used during startup recovery.
    if (req.method === "POST" && req.url === "/admin/snapshot") {
      snapshotNow();
      const entries = store.dump();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ node_id: config.nodeId, shard: config.shardId, entries }));
      return;
    }

    // GET /admin/slot-state — migrating/importing slots, used by `reshard --resume`.
    if (req.method === "GET" && req.url === "/admin/slot-state") {
      const state = clusterGossip.getSlotState();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ...state, stuck: state.migrating.length > 0 }));
      return;
    }
    // POST /admin/migrate-slot — initiate a slot migration from this shard.
    // Body: { slot: number, toShard: string }
    // Returns: { transferred: number } or an error object.
    if (req.method === "POST" && req.url === "/admin/migrate-slot") {
      let body = "";
      req.on("data", (chunk) => { body += String(chunk); });
      req.on("end", () => {
        void (async () => {
          try {
            const { slot, toShard } = JSON.parse(body) as { slot: number; toShard: string };
            if (typeof slot !== "number" || typeof toShard !== "string") {
              res.writeHead(400, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: "slot (number) and toShard (string) are required" }));
              return;
            }
            const result = await migrateSlot(slot, toShard);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(result));
          } catch (error) {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
          }
        })();
      });
      return;
    }

    // POST /admin/receive-slot — accept keys being migrated into this shard.
    // Body: { slot: number, fromShard: string, entries: SyncEntry[] }
    // Called by the source shard's leader during slot migration.
    if (req.method === "POST" && req.url === "/admin/receive-slot") {
      let body = "";
      req.on("data", (chunk) => { body += String(chunk); });
      req.on("end", () => {
        try {
          const { slot, fromShard, entries } = JSON.parse(body) as {
            slot: number;
            fromShard: string;
            entries: Array<{ key: string; value: string; expiresAt: number | null }>;
          };
          clusterGossip.beginSlotMigration(slot, fromShard, config.shardId);
          for (const entry of entries) {
            store.restoreSet(entry.key, entry.value, entry.expiresAt);
            aofLog.append({ op: "SET", key: entry.key, value: entry.value, expiresAt: entry.expiresAt });
            replication.afterLocalWrite({ op: "SET", key: entry.key, value: entry.value, expiresAt: entry.expiresAt });
          }
          log("slot_keys_received", { slot, fromShard, count: entries.length });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, received: entries.length }));
        } catch (error) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
      });
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
  const MAX_CONNECTIONS_PER_IP = config.maxConnectionsPerIp ?? 20;
  const connectionsByIp = new Map<string, number>();

  wss.on("connection", (socket: WebSocket) => {
    const connectionIp = (socket as WebSocket & { _socket?: { remoteAddress?: string } })._socket?.remoteAddress ?? "unknown";
    const connectionCount = connectionsByIp.get(connectionIp) ?? 0;
    if (connectionCount >= MAX_CONNECTIONS_PER_IP) {
      socket.close(1013, "too many connections from this address");
      log("client_rejected", { error: "connection_limit", ip: connectionIp });
      return;
    }
    connectionsByIp.set(connectionIp, connectionCount + 1);
    const connectionId = randomUUID();
    const subscriber: Subscriber = { send: (data: string) => socket.send(data) };
    const subscribedChannels = new Set<string>();

    const rateLimiter = new TokenBucket(config.rateLimitRps, config.rateLimitRps);

    socket.on("message", (data, isBinary) => {
      // A single bad frame must produce an error response, never take the
      // connection or the process down with it.
      // Responses echo the request's own framing (binary in -> binary out,
      // text in -> text out) - the wire format is opt-in per message, not
      // negotiated once for the whole connection.
      const respond = (msg: Response): void => {
        socket.send(isBinary ? encodeResponse(msg) : JSON.stringify(msg));
      };

      try {
        // Peer traffic (replication/gossip) and DASHBOARD_SUBSCRIBE are
        // always text/JSON - only client requests use the opt-in binary path.
        if (!isBinary) {
          const raw = data.toString("utf8");
          if (replication.handleInboundRaw(socket, raw)) return;
          if (clusterGossip.handleInboundRaw(socket, raw)) return;

          if (raw.includes('"DASHBOARD_SUBSCRIBE"')) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(raw);
            } catch {
              parsed = null;
            }
            if (
              parsed &&
              typeof parsed === "object" &&
              (parsed as Record<string, unknown>).type === "DASHBOARD_SUBSCRIBE"
            ) {
              dashboardListeners.add(socket);
              socket.send(JSON.stringify({ type: "DASHBOARD_SUBSCRIBED", node_id: config.nodeId }));
              return;
            }
          }
        }

        if (!rateLimiter.tryConsume()) {
          log("client_rejected", { error: "rate_limited" });
          respond({ id: null, ok: false, error: "rate_limited" });
          return;
        }

        const limits = { maxKeyBytes: config.maxKeyBytes, maxValueBytes: config.maxValueBytes };
        const result = isBinary
          ? decodeRequest(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer), limits)
          : parseRequest(data.toString("utf8"), limits);

        if (!result.ok) {
          const response: ErrResponse = result.response;
          log("client_rejected", { error: response.error });
          respond(response);
          return;
        }

        if (isStoreRequest(result.request)) {
          const isWriteOp = result.request.op !== "GET" && result.request.op !== "TTL";
          if (shuttingDown && isWriteOp) {
            respond({ id: result.request.id, ok: false, error: "shutting_down" });
            return;
          }

          if (
            config.publicDemo &&
            result.request.op !== "GET" &&
            result.request.op !== "TTL" &&
            !writeKeyValid(result.request.write_key, config.demoWriteKey)
          ) {
            log("client_rejected", { error: "write_key_required", op: result.request.op });
            respond({ id: result.request.id, ok: false, error: "write_key_required" });
            return;
          }

          const owningShard = ring.shardForKey(result.request.key);
          const slot = ring.slotForKey(result.request.key);
          const runtimeShardId = clusterGossip.shardForSlot(slot) ?? owningShard.id;
          const asking = result.request.asking === true;
          const importingHere = clusterGossip.isSlotImportingTo(slot, config.shardId);

          if (runtimeShardId !== config.shardId && !asking && !importingHere) {
            log("moved_redirect", { key: result.request.key, shard: runtimeShardId });
            respond({
              id: result.request.id,
              ok: false,
              error: "MOVED",
              shard: runtimeShardId,
              leader: clusterGossip.getCurrentLeaderUrl(runtimeShardId) ?? owningShard.leader.url
            });
            return;
          }

          if (isWriteOp && !replication.isLeader()) {
            log("moved_redirect", { key: result.request.key, shard: config.shardId, reason: "not_leader" });
            respond({
              id: result.request.id,
              ok: false,
              error: "MOVED",
              shard: config.shardId,
              leader: replication.getCurrentLeaderUrl()
            });
            return;
          }

          // ASK only from the slot's current source, and never when the client
          // is already following an ASK (that would loop with the destination).
          if (!asking && clusterGossip.isSlotMigratingFrom(slot, config.shardId)) {
            const destUrl = clusterGossip.migrationDestUrl(slot);
            if (destUrl) {
              if (isWriteOp) {
                log("ask_redirect", { key: result.request.key, slot, reason: "migrating_write" });
                respond({ id: result.request.id, ok: false, error: "ASK", shard: runtimeShardId, leader: destUrl });
                return;
              }
              if (!store.has(result.request.key)) {
                log("ask_redirect", { key: result.request.key, slot, reason: "migrating_read_not_found" });
                respond({ id: result.request.id, ok: false, error: "ASK", shard: runtimeShardId, leader: destUrl });
                return;
              }
            }
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
            log("write_applied", {
              op: result.request.op,
              key: result.request.key,
              connection_id: connectionId,
              write_key_present: "write_key" in result.request && Boolean(result.request.write_key)
            });
            if (aofEntry) replication.afterLocalWrite(aofEntry);
          }
          respond(response);
          return;
        }

        if (
          config.publicDemo &&
          result.request.op === "PUBLISH" &&
          !writeKeyValid(result.request.write_key, config.demoWriteKey)
        ) {
          log("client_rejected", { error: "write_key_required", op: result.request.op });
          respond({ id: result.request.id, ok: false, error: "write_key_required" });
          return;
        }

        if (
          result.request.op === "SUBSCRIBE" &&
          !subscribedChannels.has(result.request.channel) &&
          subscribedChannels.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION
        ) {
          log("client_rejected", { error: "too_many_subscriptions" });
          respond({ id: result.request.id, ok: false, error: "too_many_subscriptions" });
          return;
        }

        const response = dispatchPubSub(result.request, pubsub, subscriber);
        if (result.request.op === "SUBSCRIBE") subscribedChannels.add(result.request.channel);
        if (result.request.op === "UNSUBSCRIBE") subscribedChannels.delete(result.request.channel);
        if (result.request.op === "PUBLISH" && result.request.scope === "cluster") {
          clusterGossip.relayPublish(result.request.channel, result.request.message);
        }
        log("pubsub_event", { op: result.request.op, channel: result.request.channel });
        respond(response);
      } catch (error) {
        log("message_handler_error", { error: error instanceof Error ? error.message : String(error) });
        respond({ id: null, ok: false, error: "internal_error" });
      }
    });

    socket.on("close", () => {
      const remaining = (connectionsByIp.get(connectionIp) ?? 1) - 1;
      if (remaining > 0) connectionsByIp.set(connectionIp, remaining);
      else connectionsByIp.delete(connectionIp);
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
    clusterGossip.stop();
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

  // Migrate a single slot from this shard to `toShardId`.
  // 1. Gossip SLOT_MIGRATING + SLOT_IMPORTING so all nodes issue ASK redirects.
  // 2. Collect keys in the slot from the local store.
  // 3. POST those keys to the destination shard's leader via /admin/receive-slot.
  // 4. Delete keys locally and gossip SLOT_OWNED to finalize routing.
  // Idempotent if called when no keys exist for the slot.
  async function migrateSlot(slot: number, toShardId: string): Promise<{ transferred: number }> {
    const migrating = clusterGossip.getMigratingSlots().find((entry) => entry.slot === slot);
    const currentOwner = clusterGossip.shardForSlot(slot) ?? config.shardId;
    if (currentOwner === toShardId && !migrating) {
      return { transferred: 0 };
    }
    if (currentOwner !== config.shardId && migrating?.fromShard !== config.shardId) {
      throw new Error(`slot ${slot} is owned by ${currentOwner}, not this shard (${config.shardId})`);
    }
    if (!replication.isLeader()) {
      throw new Error("slot migration must be initiated from the shard leader");
    }

    const destLeaderUrl = clusterGossip.getCurrentLeaderUrl(toShardId);
    if (!destLeaderUrl) throw new Error(`no known leader URL for destination shard ${toShardId}`);

    const destHttpUrl = destLeaderUrl.replace(/^ws(s?):\/\//, (_, s: string) => `http${s}://`).replace(/\/ws$/, "");

    clusterGossip.beginSlotMigration(slot, config.shardId, toShardId);

    const entries = store.dumpSlot(slot, keySlot);

    log("slot_migration_transferring", { slot, toShard: toShardId, keys: entries.length });

    const resp = await fetch(`${destHttpUrl}/admin/receive-slot`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slot, fromShard: config.shardId, entries })
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`receive-slot failed: ${err}`);
    }

    const keys = entries.map((entry) => entry.key);
    for (const key of keys) {
      store.del(key);
      aofLog.append({ op: "DEL", key });
      replication.afterLocalWrite({ op: "DEL", key });
    }

    clusterGossip.finalizeSlotMigration(slot, toShardId);
    log("slot_migration_done", { slot, toShard: toShardId, transferred: keys.length });
    return { transferred: keys.length };
  }

  return {
    server,
    wss,
    store,
    aofLog,
    pubsub,
    ring,
    replication,
    clusterGossip,
    log,
    snapshotNow,
    close: closeInternal,
    shutdownGracefully,
    migrateSlot
  };
}
