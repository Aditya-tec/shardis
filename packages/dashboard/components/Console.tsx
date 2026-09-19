"use client";

import { useEffect, useState } from "react";
import { keySlot } from "../lib/keySlot";
import type { NodeDescriptor, NodeStatus, ShardDescriptor } from "../lib/types";
import { sendConsoleRequest, type ConsoleResult } from "../lib/wsRequest";

const OPS = ["SET", "GET", "DEL", "EXPIRE", "TTL"] as const;
type Op = (typeof OPS)[number];

const WRITE_KEY_STORAGE_KEY = "shardis-dashboard-write-key";

function loadStoredWriteKey(): string {
  try {
    return localStorage.getItem(WRITE_KEY_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function storeWriteKey(value: string): void {
  try {
    if (value) localStorage.setItem(WRITE_KEY_STORAGE_KEY, value);
    else localStorage.removeItem(WRITE_KEY_STORAGE_KEY);
  } catch {
    // Ignore - convenience only.
  }
}

export function Console({
  statuses = {},
  nodes,
  shards
}: {
  statuses?: Record<string, NodeStatus>;
  nodes: NodeDescriptor[];
  shards: ShardDescriptor[];
}) {
  const [nodeId, setNodeId] = useState(nodes[0]?.id ?? "");
  const [op, setOp] = useState<Op>("SET");
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [ttlMs, setTtlMs] = useState("");
  const [writeKey, setWriteKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<ConsoleResult[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!nodes.some((n) => n.id === nodeId) && nodes[0]) setNodeId(nodes[0].id);
  }, [nodes, nodeId]);

  const targetNode = nodes.find((n) => n.id === nodeId) ?? nodes[0];
  const isWriteOp = op !== "GET" && op !== "TTL";

  function routeForKey(nextKey: string) {
    const slot = keySlot(nextKey);
    const shard = shards.find((candidate) => slot >= candidate.hashRange[0] && slot <= candidate.hashRange[1]);
    if (!shard) return null;
    const candidates = nodes.filter((node) => shard.nodeIds.includes(node.id));
    const leader = candidates.find((node) => statuses[node.id]?.reachable && statuses[node.id]?.role === "leader");
    const reachable = candidates.find((node) => statuses[node.id]?.reachable);
    return { node: leader ?? reachable ?? candidates[0], shard: shard.id, slot };
  }

  useEffect(() => {
    if (!key.trim()) return;
    const route = routeForKey(key.trim());
    if (!route || route.node.id === nodeId) return;
    setNodeId(route.node.id);
    setError(null);
  }, [key, statuses, nodes, shards]);

  const routePreview = key.trim() ? routeForKey(key.trim()) : null;

  function explain(result: ConsoleResult): string {
    const r = result.response as {
      ok?: boolean;
      error?: string;
      value?: unknown;
      deleted?: boolean;
      updated?: boolean;
      ttl_ms?: number | null;
    };
    if (result.followedAsk) {
      return `Slot is mid-migration; followed ASK once to ${result.respondedByUrl} without caching it as permanent routing.`;
    }
    if (result.followedMoved) {
      return `The node you asked didn't own this key, so the request was auto-redirected to ${result.respondedByUrl}, the leader that does.`;
    }
    if (r.ok === false) {
      if (r.error === "write_key_required" || r.error === "invalid_write_key") {
        return "Rejected: this is a protected public demo node and needs a valid write key for writes.";
      }
      return `Rejected: ${r.error ?? "unknown error"}.`;
    }
    if (result.request.op === "GET") {
      return r.value === undefined ? "Key not found on this node." : "Read succeeded - value returned from this node's in-memory store.";
    }
    if (result.request.op === "TTL") {
      return r.ttl_ms === null ? "Key exists with no expiry." : `Remaining TTL: ${r.ttl_ms}ms.`;
    }
    if (result.request.op === "DEL") {
      return r.deleted ? "Key deleted and the change is replicating to followers." : "Nothing to delete - key didn't exist.";
    }
    return "Write accepted by the leader and is replicating to followers now.";
  }

  useEffect(() => {
    setWriteKey(loadStoredWriteKey());
  }, []);

  function handleWriteKeyChange(next: string) {
    setWriteKey(next);
    storeWriteKey(next);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!targetNode || !key.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const request: Record<string, unknown> = { op, key: key.trim() };
      if (op === "SET") {
        request.value = value;
        if (ttlMs.trim()) request.ttl_ms = Number(ttlMs);
      }
      if (op === "EXPIRE") {
        request.ttl_ms = Number(ttlMs || "0");
      }
      if (isWriteOp && writeKey.trim()) {
        request.write_key = writeKey.trim();
      }
      const route = routeForKey(key.trim());
      const result = await sendConsoleRequest((route?.node ?? targetNode).wsUrl, request as never);
      setHistory((prev) => [result, ...prev].slice(0, 30));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <form className="console-form" onSubmit={handleSubmit}>
        <select value={nodeId} onChange={(e) => setNodeId(e.target.value)} aria-label="Target node">
          {nodes.map((n) => (
            <option key={n.id} value={n.id}>
              {n.id} ({n.shard})
            </option>
          ))}
        </select>
        <select value={op} onChange={(e) => setOp(e.target.value as Op)}>
          {OPS.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        <input placeholder="key" value={key} onChange={(e) => setKey(e.target.value)} required />
        {op === "SET" && <input placeholder="value" value={value} onChange={(e) => setValue(e.target.value)} />}
        {(op === "SET" || op === "EXPIRE") && (
          <input
            placeholder="ttl_ms (optional)"
            value={ttlMs}
            onChange={(e) => setTtlMs(e.target.value)}
            style={{ maxWidth: 140 }}
          />
        )}
        {isWriteOp && (
          <input
            type="password"
            placeholder="write_key (PUBLIC_DEMO only)"
            value={writeKey}
            onChange={(e) => handleWriteKeyChange(e.target.value)}
            style={{ maxWidth: 180 }}
          />
        )}
        <button type="submit" disabled={busy || !key.trim()}>
          {busy ? "Sending..." : "Send"}
        </button>
      </form>

      {routePreview && (
        <p className="route-note">
          Slot {routePreview.slot} belongs to {routePreview.shard}; routing to {routePreview.node.id}.
        </p>
      )}

      {error && <p style={{ color: "var(--down)", fontSize: 12 }}>{error}</p>}

      <p className="hint">
        Keys are hashed to their shard and routed to a reachable leader automatically. Public-demo writes also need the
        write_key above, remembered only in this browser.
      </p>

      <div className="console-history">
        {history.map((result, i) => (
          <div className="console-history-item" key={i}>
            <div className="meta">
              {result.request.op} {result.request.key} → {result.respondedByUrl}
              {result.followedMoved ? " (followed MOVED)" : ""}
              {result.followedAsk ? " (followed ASK)" : ""}
            </div>
            <div className="explain">{explain(result)}</div>
            <div className="raw">{JSON.stringify(result.response)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
