import { NextRequest, NextResponse } from "next/server";

const TIMEOUT_MS = 10_000;

type Topology = {
  shards: Array<{
    id: string;
    leader: { id: string; url: string };
    followers: Array<{ id: string; url: string }>;
  }>;
};

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
    return response.ok ? (await response.json()) as Record<string, unknown> : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function toHttpUrl(wsUrl: string): string {
  return wsUrl.replace(/^ws(s?):\/\//, (_, secure: string) => `http${secure ? "s" : ""}://`).replace(/\/ws$/, "");
}

// The public dashboard uses this same-origin route for Render health polling.
// It prevents a browser extension, corporate network, or cross-origin policy
// from making a healthy demo look unavailable. The destination comes only from
// the configured bootstrap node's topology, never from request input.
export async function GET(request: NextRequest): Promise<NextResponse> {
  const bootstrapUrl = process.env.NEXT_PUBLIC_BOOTSTRAP_NODE_URL?.replace(/\/$/, "");
  const nodeId = request.nextUrl.searchParams.get("nodeId");
  if (!bootstrapUrl || !nodeId) return NextResponse.json({ error: "not_configured" }, { status: 400 });

  const topology = await fetchJson(`${bootstrapUrl}/topology`) as Topology | null;
  const members = topology?.shards.flatMap((shard) => [
    { ...shard.leader, shard: shard.id },
    ...shard.followers.map((follower) => ({ ...follower, shard: shard.id }))
  ]) ?? [];
  const node = members.find((member) => member.id === nodeId);
  if (!node) return NextResponse.json({ error: "node_not_found" }, { status: 404 });

  const httpUrl = toHttpUrl(node.url);
  const [healthz, metrics] = await Promise.all([fetchJson(`${httpUrl}/healthz`), fetchJson(`${httpUrl}/metrics`)]);
  if (!healthz) {
    return NextResponse.json({ id: node.id, shard: node.shard, reachable: false });
  }

  return NextResponse.json({
    id: node.id,
    shard: node.shard,
    reachable: true,
    role: healthz.role ?? "unknown",
    uptimeS: healthz.uptime_s ?? null,
    keys: metrics?.keys ?? null,
    evictions: metrics?.evictions ?? null,
    opsTotal: metrics?.ops_total ?? null,
    connectedSockets: metrics?.connected_sockets ?? null,
    connectedPeers: metrics?.connected_peers ?? null,
    replicationLagMs: metrics?.replication_lag_ms ?? null,
    lastUpdated: Date.now()
  });
}
