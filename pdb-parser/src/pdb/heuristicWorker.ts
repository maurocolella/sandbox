/* eslint-disable no-restricted-globals */
export type HeuristicWorkerInput = {
  positions: Float32Array;
  covR: Float32Array;
  offsets: Uint32Array;
  members: Uint32Array;
  cellKeys: string[];
  rangeStart: number;
  rangeEnd: number;
  slack: number;
  minDist2: number;
};

export type HeuristicWorkerOutput = {
  a: Uint32Array;
  b: Uint32Array;
  o: Uint8Array; // order
};

function buildKeyToSlot(cellKeys: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < cellKeys.length; i++) m.set(cellKeys[i]!, i);
  return m;
}

self.onmessage = (e: any) => {
  const { positions, covR, offsets, members, cellKeys, rangeStart, rangeEnd, slack, minDist2 } = e.data as HeuristicWorkerInput;
  const keyToSlot = buildKeyToSlot(cellKeys);

  const aArr: number[] = [];
  const bArr: number[] = [];
  const oArr: number[] = [];

  for (let s = rangeStart; s < rangeEnd; s++) {
    const key = cellKeys[s]!;
    const [ix, iy, iz] = key.split(",").map((t) => parseInt(t, 10));
    const startA = offsets[s]!;
    const endA = offsets[s + 1]!;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const nk = `${ix + dx},${iy + dy},${iz + dz}`;
      const t = keyToSlot.get(nk);
      if (t == null) continue;
      // Cross-cell: process only if t >= s to avoid duplicates. Same-cell handled with ia<ib below.
      if (t < s) continue;
      const startB = offsets[t]!;
      const endB = offsets[t + 1]!;
      for (let ia = startA; ia < endA; ia++) {
        const iA = members[ia]!;
        const xi = positions[iA * 3], yi = positions[iA * 3 + 1], zi = positions[iA * 3 + 2];
        const ri = covR[iA]!;
        const sameCell = s === t;
        const jb = sameCell ? ia + 1 : startB;
        for (let ib = jb; ib < endB; ib++) {
          const iB = members[ib]!;
          const xj = positions[iB * 3], yj = positions[iB * 3 + 1], zj = positions[iB * 3 + 2];
          const dxv = xi - xj, dyv = yi - yj, dzv = zi - zj;
          const d2 = dxv * dxv + dyv * dyv + dzv * dzv;
          if (d2 < minDist2) continue;
          const rj = covR[iB]!;
          const maxD = ri + rj + slack;
          if (d2 <= maxD * maxD) {
            const a = Math.min(iA, iB) >>> 0;
            const b = Math.max(iA, iB) >>> 0;
            aArr.push(a); bArr.push(b); oArr.push(1);
          }
        }
      }
    }
  }

  const out: HeuristicWorkerOutput = {
    a: Uint32Array.from(aArr),
    b: Uint32Array.from(bArr),
    o: Uint8Array.from(oArr),
  };
  // postMessage does structured clone; we can transfer buffers to save copy
  (postMessage as any)(out, [out.a.buffer, out.b.buffer, out.o.buffer]);
};
