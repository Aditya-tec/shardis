"use client";

import { useState } from "react";
import { NODES } from "../lib/clusterConfig";
import { sendConsoleRequest, type ConsoleResult } from "../lib/wsRequest";

const OPS = ["SET", "GET", "DEL", "EXPIRE"] as const;
type Op = (typeof OPS)[number];

export function Console() {
  const [nodeId, setNodeId] = useState(NODES[0]?.id ?? "");
  const [op, setOp] = useState<Op>("SET");
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [ttlMs, setTtlMs] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<ConsoleResult[]>([]);
  const [error, setError] = useState<string | null>(null);

  const targetNode = NODES.find((n) => n.id === nodeId) ?? NODES[0];

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
