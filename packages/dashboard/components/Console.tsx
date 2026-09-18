"use client";

import { useEffect, useState } from "react";
import { NODES, SHARDS } from "../lib/clusterConfig";
import { keySlot } from "../lib/keySlot";
import type { NodeStatus } from "../lib/types";
import { sendConsoleRequest, type ConsoleResult } from "../lib/wsRequest";

const OPS = ["SET", "GET", "DEL", "EXPIRE"] as const;
type Op = (typeof OPS)[number];

const WRITE_KEY_STORAGE_KEY = "shardis-dashboard-write-key";

function loadStoredWriteKey(): string {
  try {
    return localStorage.getItem(WRITE_KEY_STORAGE_KEY) ?? "";
  } catch {
    // Private browsing / blocked storage - fall back to an empty field
    // rather than breaking the console.
    return "";
  }
}

function storeWriteKey(value: string): void {
  try {
    if (value) localStorage.setItem(WRITE_KEY_STORAGE_KEY, value);
    else localStorage.removeItem(WRITE_KEY_STORAGE_KEY);
  } catch {
    // Ignore - this is a convenience, not required state.
  }
}

export function Console({ statuses = {} }: { statuses?: Record<string, NodeStatus> }) {
  const [nodeId, setNodeId] = useState(NODES[0]?.id ?? "");
  const [op, setOp] = useState<Op>("SET");
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [ttlMs, setTtlMs] = useState("");
  const [writeKey, setWriteKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<ConsoleResult[]>([]);
  const [error, setError] = useState<string | null>(null);

  const targetNode = NODES.find((n) => n.id === nodeId) ?? NODES[0];
  const isWriteOp = op !== "GET";

  function routeForKey(nextKey: string) {
    const slot = keySlot(nextKey);
    const shard = SHARDS.find((candidate) => slot >= candidate.hashRange[0] && slot <= candidate.hashRange[1]);
    if (!shard) return null;
    const candidates = NODES.filter((node) => shard.nodeIds.includes(node.id));
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
  }, [key, statuses]);

  const routePreview = key.trim() ? routeForKey(key.trim()) : null;

  function explain(result: ConsoleResult): string {
    const r = result.response as { ok?: boolean; error?: string; value?: unknown; deleted?: boolean; updated?: boolean };
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
    if (result.request.op === "DEL") {
      return r.deleted ? "Key deleted and the change is replicating to followers." : "Nothing to delete - key didn't exist.";
    }
    return "Write accepted by the leader and is replicating to followers now.";
  }

  // Loaded after mount, not as the initial state, so server-rendered HTML
  // (which has no access to the browser's localStorage) and the client's
  // first paint match - avoids a hydration mismatch.
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
          {NODES.map((n) => (
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
            </div>
            <div className="explain">{explain(result)}</div>
            <div className="raw">{JSON.stringify(result.response)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
