// Deterministic promotion, not consensus: given who's presumed dead and
// which other shard members currently look live, the lowest node id among
// {self} u {live others} wins. Every surviving node runs this same rule
// over the same locally-observed liveness, so in the common case (no
// partition) they converge on the same answer independently.
export function selectPromotedLeader(selfId: string, liveOtherIds: string[], presumedDeadLeaderId: string): string {
  const candidates = [selfId, ...liveOtherIds].filter((id) => id !== presumedDeadLeaderId);
  return candidates.sort()[0];
}
