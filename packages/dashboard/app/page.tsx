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
      <section className="hero">
        <div className="eyebrow">A distributed systems laboratory</div>
        <h1>See a key move through a real cluster.</h1>
        <p className="hero-copy">
          Shardis is a distributed key-value store built from scratch to make sharding, replication, and failover
          visible instead of mysterious.
        </p>
        <div className="hero-actions" aria-label="What you can do">
          <div><span>01</span><strong>Write a key</strong><small>Watch the leader accept it.</small></div>
          <div><span>02</span><strong>Watch replication</strong><small>See the follower catch up.</small></div>
          <div><span>03</span><strong>Break the leader</strong><small>Observe failover and recovery.</small></div>
        </div>
      </section>

      <section className="guided-flow" aria-labelledby="guided-flow-title">
        <div>
          <span className="eyebrow">Try this now</span>
          <h2 id="guided-flow-title">Four steps, one distributed write</h2>
        </div>
        <ol>
          <li><span>1</span>Write a key below - it's auto-routed to the right shard's leader.</li>
          <li><span>2</span>Watch it replicate to the follower in the node table.</li>
          <li><span>3</span>Watch the console history explain each response in plain English.</li>
        </ol>
        <p className="guided-flow-note">
          This page shows a live cluster. Leader failover (killing a node and watching a follower take over) happens
          in the terminal against a local or Docker cluster - see the README for the exact commands.
        </p>
      </section>

      <div className="header">
        <div>
          <h2>Live cluster</h2>
          <div className="subtitle">Health, ownership, replication, and events from the nodes running now.</div>
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
            <Console statuses={statuses} />
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
