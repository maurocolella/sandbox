/*
 Title: GridRaycast
 Description: Pointer raycasting component that builds a uniform grid over atom positions and performs
 3D DDA traversal to find the nearest hit efficiently. Emits onHover/onOut with instanceId, and degrades
 work while the camera is moving.
*/
import { useEffect, useRef } from "react";
import { useThree, type ThreeEvent, invalidate } from "@react-three/fiber";
import * as THREE from "three";

export interface BBox {
  min: [number, number, number];
  max: [number, number, number];
}

export interface GridRaycastProps {
  positions?: Float32Array;
  radii?: Float32Array;
  count: number;
  radiusScale: number;
  bbox?: BBox;
  isCameraMovingRef: React.MutableRefObject<boolean>;
  onHover: (e: ThreeEvent<PointerEvent>) => void;
  onOut: () => void;
}

export function GridRaycast({ positions, radii, count, radiusScale, bbox, isCameraMovingRef, onHover, onOut }: GridRaycastProps) {
  const { camera, gl } = useThree();
  const rayRef = useRef(new THREE.Raycaster());
  const lastPos = useRef(new THREE.Vector2(9999, 9999));
  const leftDown = useRef(false);
  const eps = 0.001;
  const lastInstanceId = useRef<number | null>(null);
  const gridRef = useRef<{ cell: number; min: THREE.Vector3; buckets: Map<string, Uint32Array> } | null>(null);

  useEffect(() => {
    const P = positions;
    const R = radii;
    if (!P || !R || count <= 0 || !bbox) { gridRef.current = null; return; }
    const min = new THREE.Vector3().fromArray(bbox.min);
    let avg = 0;
    for (let i = 0; i < count; i++) avg += R[i]!;
    avg = avg / Math.max(1, count);
    const cell = Math.max(0.0001, (avg * radiusScale) * 2.0);
    const buckets = new Map<string, number[]>();
    for (let i = 0; i < count; i++) {
      const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
      const ix = Math.floor((x - min.x) / cell);
      const iy = Math.floor((y - min.y) / cell);
      const iz = Math.floor((z - min.z) / cell);
      const key = `${ix},${iy},${iz}`;
      let arr = buckets.get(key);
      if (!arr) { arr = []; buckets.set(key, arr); }
      arr.push(i);
    }
    const packed = new Map<string, Uint32Array>();
    for (const [k, arr] of buckets) packed.set(k, Uint32Array.from(arr));
    gridRef.current = { cell, min, buckets: packed };
  }, [positions, radii, count, radiusScale, bbox]);
  
  // No worker: keep main-thread DDA only

  useEffect(() => {
    const el = gl.domElement;
    const handleMove = (event: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      const y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      const pos = new THREE.Vector2(x, y);
      if (leftDown.current) return;
      if (event.buttons !== 0) return; // skip raycasts during any mouse button drag
      if (isCameraMovingRef.current) {
        if (lastInstanceId.current !== null) {
          onOut();
          lastInstanceId.current = null;
          invalidate();
        }
        el.style.cursor = 'default';
        return;
      }
      if (pos.distanceTo(lastPos.current) < eps) return;
      lastPos.current.copy(pos);
      const grid = gridRef.current;
      const P = positions;
      const R = radii;
      if (!grid || !P || !R || count <= 0) {
        if (lastInstanceId.current !== null) {
          onOut();
          lastInstanceId.current = null;
          invalidate();
        }
        el.style.cursor = 'default';
        return;
      }
      rayRef.current.setFromCamera(pos, camera);
      const ro = rayRef.current.ray.origin.clone();
      const rd = rayRef.current.ray.direction.clone();
      const min = grid.min; const cell = grid.cell;
      const bboxMin = bbox?.min;
      const bboxMax = bbox?.max;
      if (!bboxMin || !bboxMax) return;
      const bb = new THREE.Box3(new THREE.Vector3().fromArray(bboxMin), new THREE.Vector3().fromArray(bboxMax));
      const tRange: { t0: number; t1: number } = (() => {
        const epsD = 1e-8;
        let tmin = -Infinity, tmax = Infinity;
        for (let a = 0; a < 3; a++) {
          const o = ro.getComponent(a);
          const d = rd.getComponent(a);
          const mn = bb.min.getComponent(a);
          const mx = bb.max.getComponent(a);
          if (Math.abs(d) < epsD) {
            // Ray parallel to slab; reject if origin outside bounds
            if (o < mn || o > mx) return { t0: 1, t1: 0 };
            continue;
          }
          const invD = 1.0 / d;
          let t1 = (mn - o) * invD;
          let t2 = (mx - o) * invD;
          if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
          if (t1 > tmin) tmin = t1;
          if (t2 < tmax) tmax = t2;
        }
        return { t0: Math.max(0, tmin), t1: tmax };
      })();
      if (tRange.t0 > tRange.t1) return;
      // Degraded mode while moving: bound work
      const moving = isCameraMovingRef.current;
      const stride = moving ? 2 : 1; // skip cells while moving
      const maxCells = moving ? 64 : 2048;
      const maxCandidates = moving ? 256 : 16384;

      // Main-thread DDA traversal
      // 3D DDA voxel traversal
      const startX = ro.x + rd.x * tRange.t0;
      const startY = ro.y + rd.y * tRange.t0;
      const startZ = ro.z + rd.z * tRange.t0;
      let ix = Math.floor((startX - min.x) / cell);
      let iy = Math.floor((startY - min.y) / cell);
      let iz = Math.floor((startZ - min.z) / cell);
      const stepX = rd.x > 0 ? 1 : (rd.x < 0 ? -1 : 0);
      const stepY = rd.y > 0 ? 1 : (rd.y < 0 ? -1 : 0);
      const stepZ = rd.z > 0 ? 1 : (rd.z < 0 ? -1 : 0);

      const nextBoundary = (i: number, s: number) => s > 0 ? (i + 1) * cell + min.x : i * cell + min.x;
      const nextBoundaryY = (j: number, s: number) => s > 0 ? (j + 1) * cell + min.y : j * cell + min.y;
      const nextBoundaryZ = (k: number, s: number) => s > 0 ? (k + 1) * cell + min.z : k * cell + min.z;

      const safeInv = (v: number) => v === 0 ? Infinity : 1 / v;
      let tMaxX = stepX === 0 ? Infinity : (nextBoundary(ix, stepX) - startX) * safeInv(rd.x);
      let tMaxY = stepY === 0 ? Infinity : (nextBoundaryY(iy, stepY) - startY) * safeInv(rd.y);
      let tMaxZ = stepZ === 0 ? Infinity : (nextBoundaryZ(iz, stepZ) - startZ) * safeInv(rd.z);
      const tDeltaX = stepX === 0 ? Infinity : Math.abs(cell * safeInv(rd.x));
      const tDeltaY = stepY === 0 ? Infinity : Math.abs(cell * safeInv(rd.y));
      const tDeltaZ = stepZ === 0 ? Infinity : Math.abs(cell * safeInv(rd.z));

      let bestId: number | null = null;
      let bestT = Infinity;
      let tested = 0;
      let cellsVisited = 0;
      let tCursor = tRange.t0;
      while (tCursor <= tRange.t1 && cellsVisited < maxCells) {
        // Test current voxel bucket
        const key = `${ix},${iy},${iz}`;
        const bucket = grid.buckets.get(key);
        if (bucket) {
          for (let k = 0; k < bucket.length; k++) {
            if (tested >= maxCandidates) break;
            const j = bucket[k]!;
            const cx = P[j * 3], cy = P[j * 3 + 1], cz = P[j * 3 + 2];
            const r = R[j]! * radiusScale;
            const ocx = ro.x - cx, ocy = ro.y - cy, ocz = ro.z - cz;
            const b = ocx * rd.x + ocy * rd.y + ocz * rd.z;
            const c = ocx * ocx + ocy * ocy + ocz * ocz - r * r;
            const disc = b * b - c;
            if (disc < 0) { tested++; continue; }
            const tHit = -b - Math.sqrt(disc);
            if (tHit >= tRange.t0 && tHit <= tRange.t1 && tHit < bestT) {
              bestT = tHit; bestId = j;
            }
            tested++;
          }
        }
        // Early exit if best hit is before the next voxel boundary
        const nextBoundaryT = Math.min(tMaxX, tMaxY, tMaxZ) + tRange.t0;
        if (bestT < nextBoundaryT) break;
        // Advance to next voxel
        if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
          ix += stepX * stride;
          tCursor = tRange.t0 + tMaxX;
          tMaxX += tDeltaX * stride;
        } else if (tMaxY <= tMaxX && tMaxY <= tMaxZ) {
          iy += stepY * stride;
          tCursor = tRange.t0 + tMaxY;
          tMaxY += tDeltaY * stride;
        } else {
          iz += stepZ * stride;
          tCursor = tRange.t0 + tMaxZ;
          tMaxZ += tDeltaZ * stride;
        }
        cellsVisited++;
        if (tested >= maxCandidates) break;
      }
      const instanceId = bestId;
      if (instanceId == null) {
        if (lastInstanceId.current !== null) {
          onOut();
          lastInstanceId.current = null;
          invalidate();
        }
        el.style.cursor = 'default';
      } else if (lastInstanceId.current !== instanceId) {
        lastInstanceId.current = instanceId;
        const fakeEvt = {
          stopPropagation: () => {},
          instanceId,
        } as unknown as ThreeEvent<PointerEvent>;
        onHover(fakeEvt);
        invalidate();
        el.style.cursor = 'pointer';
      }
    };
    const handleDown = () => { leftDown.current = true; };
    const handleUp = () => { leftDown.current = false; };
    const handleLeave = () => { onOut(); el.style.cursor = 'default'; };
    el.addEventListener("mousemove", handleMove);
    el.addEventListener("mousedown", handleDown);
    el.addEventListener("mouseup", handleUp);
    el.addEventListener("mouseleave", handleLeave);
    return () => {
      el.removeEventListener("mousemove", handleMove);
      el.removeEventListener("mousedown", handleDown);
      el.removeEventListener("mouseup", handleUp);
      el.removeEventListener("mouseleave", handleLeave);
    };
  }, [gl, camera, onHover, onOut, positions, radii, count, radiusScale, bbox, isCameraMovingRef]);

  return null;
}
