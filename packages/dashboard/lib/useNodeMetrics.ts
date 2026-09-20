"use client";

import { useEffect, useState } from "react";
import type { NodeDescriptor, NodeStatus } from "./types";

const POLL_INTERVAL_MS = 1500;
// Public demos can traverse a managed proxy and may wake from an idle state.
// Keep the dashboard responsive while allowing a realistic Render round trip;
// the polling interval prevents a slow node from permanently blocking updates.
const FETCH_TIMEOUT_MS = 6000;

function unreachable(id: string, shard: string): NodeStatus {
  return {
    id,
    shard,
    reachable: false,
    role: "unknown",
    uptimeS: null,
    keys: null,
    evictions: null,
    opsTotal: null,
    connectedSockets: null,
    connectedPeers: null,
    replicationLagMs: null,
    lastUpdated: Date.now()
  };
}

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function pollNode(id: string, shard: string, httpUrl: string): Promise<NodeStatus> {
  const [healthz, metrics] = await Promise.all([
    fetchJson(`${httpUrl}/healthz`),
    fetchJson(`${httpUrl}/metrics`)
  ]);

  if (!healthz) return unreachable(id, shard);

  return {
    id,
    shard,
    reachable: true,
    role: (healthz.role as NodeStatus["role"]) ?? "unknown",
    uptimeS: (healthz.uptime_s as number) ?? null,
    keys: (metrics?.keys as number) ?? null,
    evictions: (metrics?.evictions as number) ?? null,
    opsTotal: (metrics?.ops_total as number) ?? null,
    connectedSockets: (metrics?.connected_sockets as number) ?? null,
    connectedPeers: (metrics?.connected_peers as number) ?? null,
    replicationLagMs: (metrics?.replication_lag_ms as number | null) ?? null,
    lastUpdated: Date.now()
  };
}

export function useNodeMetrics(nodes: NodeDescriptor[]): Record<string, NodeStatus> {
  const [statuses, setStatuses] = useState<Record<string, NodeStatus>>(() =>
    Object.fromEntries(nodes.map((n) => [n.id, unreachable(n.id, n.shard)]))
  );

  useEffect(() => {
    let cancelled = false;

    async function pollAll() {
      const results = await Promise.all(nodes.map((n) => pollNode(n.id, n.shard, n.httpUrl)));
      if (cancelled) return;
      setStatuses(Object.fromEntries(results.map((r) => [r.id, r])));
    }

    void pollAll();
    const timer = setInterval(() => void pollAll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [nodes]);

  return statuses;
}
