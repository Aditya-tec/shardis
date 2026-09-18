"use client";

import { useEffect, useRef, useState } from "react";
import { NODES } from "./clusterConfig";
import type { LiveEvent } from "./types";

const MAX_EVENTS = 300;
const RECONNECT_DELAY_MS = 2000;

export function useEventFeed(): LiveEvent[] {
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const eventsRef = useRef<LiveEvent[]>([]);

  useEffect(() => {
    let stopped = false;
    const sockets: WebSocket[] = [];

    function connect(nodeId: string, wsUrl: string): void {
      if (stopped) return;
      let socket: WebSocket;
      try {
        socket = new WebSocket(wsUrl);
      } catch {
        setTimeout(() => connect(nodeId, wsUrl), RECONNECT_DELAY_MS);
        return;
      }
      sockets.push(socket);

      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ type: "DASHBOARD_SUBSCRIBE" }));
      });

      socket.addEventListener("message", (evt) => {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(evt.data as string);
        } catch {
          return;
        }
        if (parsed.type === "DASHBOARD_SUBSCRIBED") return;
        if (typeof parsed.event !== "string") return;

        const entry: LiveEvent = { nodeId, ts: String(parsed.ts ?? new Date().toISOString()), ...parsed } as LiveEvent;
        eventsRef.current = [entry, ...eventsRef.current].slice(0, MAX_EVENTS);
        setEvents(eventsRef.current);
      });

      socket.addEventListener("close", () => {
        if (!stopped) setTimeout(() => connect(nodeId, wsUrl), RECONNECT_DELAY_MS);
      });

      socket.addEventListener("error", () => {
        socket.close();
      });
    }

    for (const node of NODES) connect(node.id, node.wsUrl);

    return () => {
      stopped = true;
      for (const socket of sockets) socket.close();
    };
  }, []);

  return events;
}
