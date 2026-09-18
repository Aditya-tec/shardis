"use client";

import { Console } from "../components/Console";
import { EventFeed } from "../components/EventFeed";
import { HashRing } from "../components/HashRing";
import { NodeTable } from "../components/NodeTable";
import { useEventFeed } from "../lib/useEventFeed";
import { useNodeMetrics } from "../lib/useNodeMetrics";

export default function DashboardPage() {
  const statuses = useNodeMetrics();
  const events = useEventFeed();

  return (
    <main className="page">
      <div className="header">
        <div>
          <h1>shardis cluster dashboard</h1>
          <div className="subtitle">
            Small, honest scale by design - the point is correct distributed-systems behavior under controlled
            chaos, not raw throughput.
          </div>
        </div>
      </div>

      <div className="grid">
        <div className="panel">
          <h2>Hash ring</h2>
          <HashRing statuses={statuses} />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div className="panel">
            <h2>Nodes</h2>
            <NodeTable statuses={statuses} />
          </div>

          <div className="panel">
            <h2>Console</h2>
            <Console />
          </div>

          <div className="panel">
            <h2>Live event feed</h2>
            <EventFeed events={events} />
          </div>
        </div>
      </div>
    </main>
  );
}
