"use client";

import type { LiveEvent } from "../lib/types";

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return iso;
  }
}

function formatFields(event: LiveEvent): string {
  const { nodeId: _nodeId, ts: _ts, event: _event, ...rest } = event;
  const entries = Object.entries(rest);
  if (entries.length === 0) return "";
  return entries.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ");
}

export function EventFeed({ events, loading = false }: { events: LiveEvent[]; loading?: boolean }) {
  if (loading) {
    return <div className="event-skeleton" aria-label="Connecting to cluster events" aria-busy="true"><span className="skeleton skeleton-wide" /><span className="skeleton skeleton-wide" /><span className="skeleton skeleton-wide" /></div>;
  }
  if (events.length === 0) {
    return <p className="hint">Waiting for events... make a write against the cluster to see one land here.</p>;
  }

  const latest = events[0];
  const explanation = latest.event === "moved_redirect"
    ? `This request was redirected to the current leader of ${String(latest.shard ?? "the owning shard")}.`
    : latest.event === "replication_applied"
      ? `A follower applied ${String(latest.op ?? "a write")} for ${String(latest.key ?? "a key")} from its leader.`
      : latest.event === "failover_triggered" || latest.event === "leader_changed"
        ? `Leadership changed from ${String(latest.previousLeader ?? "the old leader")} to ${String(latest.newLeader ?? "a new leader")}.`
        : latest.event === "write_applied"
          ? `A write was durably accepted by ${latest.nodeId} and broadcast to its followers.`
          : `The latest cluster event was ${latest.event.replaceAll("_", " ")}.`;

  return (
    <>
      <div className="event-explainer">
        <span className="event-explainer-label">What just happened</span>
        <strong>{explanation}</strong>
      </div>
      <div className="event-feed">
      {events.map((event, i) => (
        <div className="event-row" key={`${event.nodeId}-${event.ts}-${i}`}>
          <span className="time">{formatTime(event.ts)}</span>
          <span className="node mono">{event.nodeId}</span>
          <span className={`type ${event.event}`}>{event.event}</span>
          <span className="fields">{formatFields(event)}</span>
        </div>
      ))}
      </div>
    </>
  );
}
