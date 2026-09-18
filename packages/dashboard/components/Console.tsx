"use client";

import { useEffect, useState } from "react";
import { NODES } from "../lib/clusterConfig";
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

export function Console() {
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
      const result = await sendConsoleRequest(targetNode.wsUrl, request as never);
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
        <select value={nodeId} onChange={(e) => setNodeId(e.target.value)}>
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

      {error && <p style={{ color: "var(--down)", fontSize: 12 }}>{error}</p>}

      <p className="hint">
        Any command that gets a MOVED response is automatically retried once against the returned leader URL, so a
        write sent to the wrong node still lands - as long as that leader URL is reachable from your browser. Against
        the local Docker Compose cluster, cluster.config.local.json's URLs are the internal ws://node-a1:7000-style
        addresses the nodes use to reach each other, not the host ports this dashboard uses, so a cross-shard MOVED
        follow from here will fail to resolve (it surfaces as a "could not connect" error, not a hang). Pick the
        node that already owns your key to avoid the redirect, same as with shardis-cli against this cluster.
        Against a node running with PUBLIC_DEMO=true, writes also need the write_key field above (remembered in
        this browser only, never sent anywhere but the node you choose above).
      </p>

      <div className="console-history">
        {history.map((result, i) => (
          <div className="console-history-item" key={i}>
            <div className="meta">
              {result.request.op} {result.request.key} → {result.respondedByUrl}
              {result.followedMoved ? " (followed MOVED)" : ""}
            </div>
            <div>{JSON.stringify(result.response)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
