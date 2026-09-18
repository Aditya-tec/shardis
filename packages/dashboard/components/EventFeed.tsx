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

export function EventFeed({ events }: { events: LiveEvent[] }) {
  if (events.length === 0) {
    return <p className="hint">Waiting for events... make a write against the cluster to see one land here.</p>;
  }

  return (
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
  );
}
