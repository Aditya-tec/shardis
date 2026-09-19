"use client";

import { useEffect, useState } from "react";
import {
  BOOTSTRAP_NODE_URL,
  DEFAULT_NODES,
  DEFAULT_SHARDS,
  descriptorsFromTopology,
  type ClusterTopologyJson
} from "./clusterConfig";
import type { NodeDescriptor, ShardDescriptor } from "./types";

export interface ClusterTopology {
  nodes: NodeDescriptor[];
  shards: ShardDescriptor[];
}

export function useClusterTopology(): ClusterTopology {
  const [topology, setTopology] = useState<ClusterTopology>({
    nodes: DEFAULT_NODES,
    shards: DEFAULT_SHARDS
  });

  useEffect(() => {
    if (!BOOTSTRAP_NODE_URL) return;
    const httpUrl = BOOTSTRAP_NODE_URL.replace(/\/$/, "");
    void fetch(`${httpUrl}/topology`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) return;
        const json = (await res.json()) as ClusterTopologyJson;
        if (!Array.isArray(json.shards)) return;
        setTopology(descriptorsFromTopology(json));
      })
      .catch(() => {
        // Keep the compiled-in defaults if the bootstrap node is asleep.
      });
  }, []);

  return topology;
}
