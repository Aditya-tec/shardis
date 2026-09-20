"use client";

import { HASH_SLOT_COUNT } from "../lib/clusterConfig";
import type { NodeStatus, ShardDescriptor } from "../lib/types";

const COLORS = ["#5b8cff", "#4ade80", "#fbbf24", "#f472b6", "#60a5fa", "#a78bfa"];

function arcPath(cx: number, cy: number, r: number, startAngle: number, endAngle: number): string {
  const start = {
    x: cx + r * Math.cos(startAngle),
    y: cy + r * Math.sin(startAngle)
  };
  const end = {
    x: cx + r * Math.cos(endAngle),
    y: cy + r * Math.sin(endAngle)
  };
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
  return `M ${cx} ${cy} L ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y} Z`;
}

export function HashRing({ statuses, shards, loading = false }: { statuses: Record<string, NodeStatus>; shards: ShardDescriptor[]; loading?: boolean }) {
  if (loading) {
    return <div className="ring-skeleton" aria-label="Loading cluster topology" aria-busy="true"><span className="skeleton ring-skeleton-circle" /><span className="skeleton skeleton-wide" /><span className="skeleton skeleton-wide" /></div>;
  }
  const size = 320;
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 40;

  let cursor = -Math.PI / 2;

  const segments = shards.map((shard, i) => {
    const span = shard.hashRange[1] - shard.hashRange[0] + 1;
    const fraction = span / HASH_SLOT_COUNT;
    const startAngle = cursor;
    const endAngle = cursor + fraction * Math.PI * 2;
    cursor = endAngle;

    const leaderId = shard.nodeIds.find((id) => statuses[id]?.role === "leader");
    const anyReachable = shard.nodeIds.some((id) => statuses[id]?.reachable);

    const midAngle = (startAngle + endAngle) / 2;
    const labelR = r + 20;

    return {
      shard,
      color: COLORS[i % COLORS.length],
      // SVG arcs cannot represent a 360° segment when their start and end
      // positions coincide. The reduced public demo has one shard covering
      // all slots, so draw that valid topology as a circle explicitly.
      path: fraction >= 1 ? null : arcPath(cx, cy, r, startAngle, endAngle),
      leaderId,
      anyReachable,
      labelX: cx + labelR * Math.cos(midAngle),
      labelY: cy + labelR * Math.sin(midAngle)
    };
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {segments.map((seg) => (
          seg.path ? (
            <path key={seg.shard.id} d={seg.path} fill={seg.color} opacity={seg.anyReachable ? 0.9 : 0.25} stroke="var(--panel)" strokeWidth={2} />
          ) : (
            <circle key={seg.shard.id} cx={cx} cy={cy} r={r} fill={seg.color} opacity={seg.anyReachable ? 0.9 : 0.25} stroke="var(--panel)" strokeWidth={2} />
          )
        ))}
        {segments.map((seg) => (
          <text
            key={`${seg.shard.id}-label`}
            x={seg.labelX}
            y={seg.labelY}
            fill="var(--text-dim)"
            fontSize={11}
            textAnchor="middle"
            dominantBaseline="middle"
          >
            {seg.shard.id}
          </text>
        ))}
        <circle cx={cx} cy={cy} r={r * 0.45} fill="var(--panel)" />
        <text x={cx} y={cy - 6} fill="var(--text)" fontSize={13} textAnchor="middle" fontWeight={600}>
          {HASH_SLOT_COUNT} slots
        </text>
        <text x={cx} y={cy + 12} fill="var(--text-dim)" fontSize={11} textAnchor="middle">
          {shards.length} shards
        </text>
      </svg>

      <div style={{ width: "100%", marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
        {segments.map((seg) => (
          <div key={seg.shard.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 3,
                background: seg.color,
                opacity: seg.anyReachable ? 1 : 0.3,
                flexShrink: 0
              }}
            />
            <span className="mono">{seg.shard.id}</span>
            <span style={{ color: "var(--text-dim)" }}>
              [{seg.shard.hashRange[0]}-{seg.shard.hashRange[1]}]
            </span>
            <span style={{ marginLeft: "auto" }} className="mono">
              {seg.leaderId ? (
                <>
                  <span className="dot leader" />
                  {seg.leaderId}
                </>
              ) : (
                <span style={{ color: "var(--down)" }}>no leader visible</span>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
