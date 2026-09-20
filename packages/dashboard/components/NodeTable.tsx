"use client";

import type { NodeDescriptor, NodeStatus } from "../lib/types";

function formatUptime(seconds: number | null): string {
  if (seconds === null) return "-";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function StatusBadge({ status }: { status: NodeStatus }) {
  if (!status.reachable) return <span className="badge down">down</span>;
  if (status.role === "leader") return <span className="badge leader">leader</span>;
  return <span className="badge follower">follower</span>;
}

// Topology discovery can replace the initial local node list before the first
// metrics poll for the newly discovered nodes completes. Keep that one-render
// loading window safe and visibly represent it as an unavailable node instead
// of dereferencing an absent status object.
function pendingStatus(node: NodeDescriptor): NodeStatus {
  return {
    id: node.id,
    shard: node.shard,
    reachable: false,
    role: "unknown",
    uptimeS: null,
    keys: null,
    evictions: null,
    opsTotal: null,
    connectedSockets: null,
    connectedPeers: null,
    replicationLagMs: null,
    lastUpdated: 0
  };
}

export function NodeTable({
  statuses,
  nodes,
  loading = false
}: {
  statuses: Record<string, NodeStatus>;
  nodes: NodeDescriptor[];
  loading?: boolean;
}) {
  if (loading) {
    return (
      <div className="table-scroll" aria-label="Loading node status" aria-busy="true">
        <table className="skeleton-table">
          <thead><tr><th>Node</th><th>Shard</th><th>Role</th><th>Uptime</th><th>Keys</th><th>Evictions</th><th>Ops</th><th>Peers</th><th>Repl. lag</th></tr></thead>
          <tbody>{nodes.map((node) => <tr key={node.id}><td><span className="skeleton skeleton-name" /></td><td><span className="skeleton skeleton-short" /></td><td><span className="skeleton skeleton-badge" /></td><td colSpan={6}><span className="skeleton skeleton-wide" /></td></tr>)}</tbody>
        </table>
      </div>
    );
  }
  return (
    <table>
      <thead>
        <tr>
          <th>Node</th>
          <th>Shard</th>
          <th>Role</th>
          <th>Uptime</th>
          <th>Keys</th>
          <th>Evictions</th>
          <th>Ops</th>
          <th>Peers</th>
          <th>Repl. lag</th>
        </tr>
      </thead>
      <tbody>
        {nodes.map((node) => {
          const status = statuses[node.id] ?? pendingStatus(node);
          return (
            <tr key={node.id}>
              <td className="mono">
                <span className={`dot ${status.reachable ? status.role : "down"}`} />
                {node.id}
              </td>
              <td>{node.shard}</td>
              <td>
                <StatusBadge status={status} />
              </td>
              <td>{formatUptime(status.uptimeS)}</td>
              <td>{status.keys ?? "-"}</td>
              <td>{status.evictions ?? "-"}</td>
              <td>{status.opsTotal ?? "-"}</td>
              <td>{status.connectedPeers ?? "-"}</td>
              <td>{status.replicationLagMs === null ? "-" : `${status.replicationLagMs}ms`}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
