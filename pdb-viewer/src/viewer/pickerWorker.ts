export type InitMsg = {
  type: "init";
  positions: Float32Array;
  radii: Float32Array;
  bboxMin: [number, number, number];
  bboxMax: [number, number, number];
};

export type PickMsg = {
  type: "pick";
  origin: [number, number, number];
  direction: [number, number, number];
  moving: boolean;
  stride: number;
  maxCells: number;
  maxCandidates: number;
  radiusScale: number;
  seq: number;
};

export type WorkerIn = InitMsg | PickMsg;

export type ReadyMsg = { type: "ready" };
export type PickResult = { type: "result"; seq: number; instanceId: number | null };

// Internal state
let P: Float32Array | null = null;
let R: Float32Array | null = null;
let bboxMin: [number, number, number] | null = null;
let bboxMax: [number, number, number] | null = null;
let cell = 1.0;
let minX = 0, minY = 0, minZ = 0;
// Grid: packed members with key-to-slot
let cellKeys: string[] = [];
let keyToSlot: Map<string, number> = new Map();
let offsets: Uint32Array | null = null;
let members: Uint32Array | null = null;

function buildGrid(): void {
  if (!P || !R || !bboxMin || !bboxMax) return;
  // Cell based on avg base radii (no scale), tight enough but independent of UI scale
  let avg = 0;
  const count = R.length | 0;
  for (let i = 0; i < count; i++) avg += R[i]!;
  avg = avg / Math.max(1, count);
  cell = Math.max(0.0001, avg * 2.0);
  minX = bboxMin[0]; minY = bboxMin[1]; minZ = bboxMin[2];

  const counts = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    const ix = Math.floor((x - minX) / cell);
    const iy = Math.floor((y - minY) / cell);
    const iz = Math.floor((z - minZ) / cell);
    const k = `${ix},${iy},${iz}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  cellKeys = Array.from(counts.keys());
  keyToSlot = new Map<string, number>();
  for (let i = 0; i < cellKeys.length; i++) keyToSlot.set(cellKeys[i]!, i);
  offsets = new Uint32Array(cellKeys.length + 1);
  for (let i = 0; i < cellKeys.length; i++) offsets[i + 1] = offsets[i]! + (counts.get(cellKeys[i]!)!);
  members = new Uint32Array(offsets[cellKeys.length]!);
  const cursor = new Uint32Array(cellKeys.length);
  for (let i = 0; i < count; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    const ix = Math.floor((x - minX) / cell);
    const iy = Math.floor((y - minY) / cell);
    const iz = Math.floor((z - minZ) / cell);
    const k = `${ix},${iy},${iz}`;
    const s = keyToSlot.get(k)!;
    const dst = offsets[s]! + (cursor[s]++);
    members[dst] = i >>> 0;
  }
}

function pick(msg: PickMsg): PickResult {
  if (!P || !R || !offsets || !members || !bboxMin || !bboxMax) return { type: "result", seq: msg.seq, instanceId: null };
  const rox = msg.origin[0], roy = msg.origin[1], roz = msg.origin[2];
  const rdx = msg.direction[0], rdy = msg.direction[1], rdz = msg.direction[2];
  const rs = msg.radiusScale;

  // AABB slab
  const epsD = 1e-8;
  let tmin = -Infinity, tmax = Infinity;
  {
    const o = rox, d = rdx, mn = bboxMin[0], mx = bboxMax[0];
    if (Math.abs(d) < epsD) { if (o < mn || o > mx) return { type: "result", seq: msg.seq, instanceId: null }; }
    else { const inv = 1 / d; let t1 = (mn - o) * inv; let t2 = (mx - o) * inv; if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; } if (t1 > tmin) tmin = t1; if (t2 < tmax) tmax = t2; }
  }
  {
    const o = roy, d = rdy, mn = bboxMin[1], mx = bboxMax[1];
    if (Math.abs(d) < epsD) { if (o < mn || o > mx) return { type: "result", seq: msg.seq, instanceId: null }; }
    else { const inv = 1 / d; let t1 = (mn - o) * inv; let t2 = (mx - o) * inv; if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; } if (t1 > tmin) tmin = t1; if (t2 < tmax) tmax = t2; }
  }
  {
    const o = roz, d = rdz, mn = bboxMin[2], mx = bboxMax[2];
    if (Math.abs(d) < epsD) { if (o < mn || o > mx) return { type: "result", seq: msg.seq, instanceId: null }; }
    else { const inv = 1 / d; let t1 = (mn - o) * inv; let t2 = (mx - o) * inv; if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; } if (t1 > tmin) tmin = t1; if (t2 < tmax) tmax = t2; }
  }
  const t0 = Math.max(0, tmin), t1 = tmax;
  if (t0 > t1) return { type: "result", seq: msg.seq, instanceId: null };

  const moving = msg.moving;
  const stride = msg.stride;
  const maxCells = msg.maxCells;
  const maxCandidates = msg.maxCandidates;

  // Starting cell
  const startX = rox + rdx * t0;
  const startY = roy + rdy * t0;
  const startZ = roz + rdz * t0;
  let ix = Math.floor((startX - minX) / cell);
  let iy = Math.floor((startY - minY) / cell);
  let iz = Math.floor((startZ - minZ) / cell);
  const stepX = rdx > 0 ? 1 : (rdx < 0 ? -1 : 0);
  const stepY = rdy > 0 ? 1 : (rdy < 0 ? -1 : 0);
  const stepZ = rdz > 0 ? 1 : (rdz < 0 ? -1 : 0);

  const nextBoundaryX = (i: number, s: number) => s > 0 ? (i + 1) * cell + minX : i * cell + minX;
  const nextBoundaryY = (j: number, s: number) => s > 0 ? (j + 1) * cell + minY : j * cell + minY;
  const nextBoundaryZ = (k: number, s: number) => s > 0 ? (k + 1) * cell + minZ : k * cell + minZ;

  const safeInv = (v: number) => v === 0 ? Infinity : 1 / v;
  let tMaxX = stepX === 0 ? Infinity : (nextBoundaryX(ix, stepX) - startX) * safeInv(rdx);
  let tMaxY = stepY === 0 ? Infinity : (nextBoundaryY(iy, stepY) - startY) * safeInv(rdy);
  let tMaxZ = stepZ === 0 ? Infinity : (nextBoundaryZ(iz, stepZ) - startZ) * safeInv(rdz);
  const tDeltaX = stepX === 0 ? Infinity : Math.abs(cell * safeInv(rdx));
  const tDeltaY = stepY === 0 ? Infinity : Math.abs(cell * safeInv(rdy));
  const tDeltaZ = stepZ === 0 ? Infinity : Math.abs(cell * safeInv(rdz));

  let bestId: number | null = null;
  let bestT = Infinity;
  let tested = 0;
  let cellsVisited = 0;
  let tCursor = t0;

  while (tCursor <= t1 && cellsVisited < maxCells && tested < maxCandidates) {
    const key = `${ix},${iy},${iz}`;
    const s = keyToSlot.get(key);
    if (s != null) {
      const start = offsets![s]!;
      const end = offsets![s + 1]!;
      for (let idx = start; idx < end; idx++) {
        if (tested >= maxCandidates) break;
        const j = members![idx]!;
        const cx = P![j * 3], cy = P![j * 3 + 1], cz = P![j * 3 + 2];
        const r = R![j]! * rs;
        const ocx = rox - cx, ocy = roy - cy, ocz = roz - cz;
        const b = ocx * rdx + ocy * rdy + ocz * rdz;
        const c = ocx * ocx + ocy * ocy + ocz * ocz - r * r;
        const disc = b * b - c;
        if (disc >= 0) {
          const tHit = -b - Math.sqrt(disc);
          if (tHit >= t0 && tHit <= t1 && tHit < bestT) {
            bestT = tHit; bestId = j;
          }
        }
        tested++;
      }
    }
    const nextBoundaryT = Math.min(tMaxX, tMaxY, tMaxZ) + t0;
    if (bestT < nextBoundaryT) break;
    if (tMaxX <= tMaxY && tMaxX <= tMaxZ) { ix += stepX * (moving ? stride : 1); tCursor = t0 + tMaxX; tMaxX += tDeltaX * (moving ? stride : 1); }
    else if (tMaxY <= tMaxX && tMaxY <= tMaxZ) { iy += stepY * (moving ? stride : 1); tCursor = t0 + tMaxY; tMaxY += tDeltaY * (moving ? stride : 1); }
    else { iz += stepZ * (moving ? stride : 1); tCursor = t0 + tMaxZ; tMaxZ += tDeltaZ * (moving ? stride : 1); }
    cellsVisited++;
  }

  return { type: "result", seq: msg.seq, instanceId: bestId };
}

self.onmessage = (e: MessageEvent<WorkerIn>) => {
  const data = e.data;
  if (data.type === "init") {
    P = data.positions;
    R = data.radii;
    bboxMin = data.bboxMin;
    bboxMax = data.bboxMax;
    buildGrid();
    const ready: ReadyMsg = { type: "ready" };
    postMessage(ready);
  } else if (data.type === "pick") {
    const res = pick(data);
    postMessage(res);
  }
};
