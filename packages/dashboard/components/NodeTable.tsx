"use client";

import { NODES } from "../lib/clusterConfig";
import type { NodeStatus } from "../lib/types";

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

export function NodeTable({ statuses }: { statuses: Record<string, NodeStatus> }) {
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
        {NODES.map((node) => {
          const status = statuses[node.id];
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
