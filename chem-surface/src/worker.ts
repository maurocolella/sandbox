import { generateVDW, generateSAS, generateSES, generateStreaming, type Atom, type SurfaceOptions, type SurfaceGeometry, type SurfaceKind, type StreamOptions } from './index.js';
import { findPockets, pocketSurface, type PocketOptions } from './pockets.js';

export type { SurfaceKind } from './index.js';

export type SurfaceRequest =
  | {
      id: number;
      kind: SurfaceKind;
      atoms: Atom[];
      options?: Omit<SurfaceOptions, 'signal'>; // AbortSignal cannot cross the worker boundary
    }
  | { id: number; kind: 'pockets'; atoms: Atom[]; options?: Omit<PocketOptions, 'signal'> }
  | { id: number; kind: SurfaceKind; stream: true; atoms: Atom[]; options?: Omit<StreamOptions, 'signal'> }
  | { id: number; kind: 'pocket-meshes'; sets: { index: number; atoms: Atom[] }[] };

export interface PocketMessage {
  positions: ArrayBuffer;
  normals: ArrayBuffer;
  indices: ArrayBuffer;
  lining: ArrayBuffer;
  volume: number;
  buriedness: number;
  score: number;
  center: { x: number; y: number; z: number };
}

export type SurfaceResponse =
  | {
      id: number;
      ok: true;
      positions: ArrayBuffer;
      normals: ArrayBuffer;
      indices?: ArrayBuffer;
      atomIndex?: ArrayBuffer;
    }
  | { id: number; ok: true; pockets: PocketMessage[] }
  | { id: number; chunk: { positions: ArrayBuffer; normals: ArrayBuffer; indices: ArrayBuffer; atomIndex?: ArrayBuffer }; index?: number }
  | { id: number; ok: true; done: true }
  | { id: number; ok: false; error: string };

async function handle(req: SurfaceRequest): Promise<void> {
  const scope = self as unknown as DedicatedWorkerGlobalScope;
  try {
    if ('stream' in req) {
      // One message per brick as it's done, then a final one
      generateStreaming(req.kind, req.atoms, req.options ?? {}, (c) => {
        const chunk = { positions: c.positions.buffer as ArrayBuffer, normals: c.normals.buffer as ArrayBuffer, indices: c.indices.buffer as ArrayBuffer, atomIndex: c.atomIndex!.buffer as ArrayBuffer };
        scope.postMessage({ id: req.id, chunk } satisfies SurfaceResponse, [chunk.positions, chunk.normals, chunk.indices, chunk.atomIndex]);
      });
      scope.postMessage({ id: req.id, ok: true, done: true } satisfies SurfaceResponse);
      return;
    }
    if (req.kind === 'pocket-meshes') {
      for (const { index, atoms } of req.sets) {
        const m = pocketSurface(atoms);
        const chunk = { positions: m.positions.buffer as ArrayBuffer, normals: m.normals.buffer as ArrayBuffer, indices: (m.indices ?? new Uint32Array(0)).buffer as ArrayBuffer };
        scope.postMessage({ id: req.id, chunk, index } satisfies SurfaceResponse, [chunk.positions, chunk.normals, chunk.indices]);
      }
      scope.postMessage({ id: req.id, ok: true, done: true } satisfies SurfaceResponse);
      return;
    }
    if (req.kind === 'pockets') {
      const pockets = findPockets(req.atoms, req.options ?? {}).map((p) => ({
        ...p,
        positions: p.positions.buffer as ArrayBuffer,
        normals: p.normals.buffer as ArrayBuffer,
        indices: p.indices.buffer as ArrayBuffer,
        lining: p.lining.buffer as ArrayBuffer,
      }));
      scope.postMessage({ id: req.id, ok: true, pockets } satisfies SurfaceResponse, pockets.flatMap((p) => [p.positions, p.normals, p.indices, p.lining]));
      return;
    }
    let geom: SurfaceGeometry;
    if (req.kind === 'vdw') geom = await generateVDW(req.atoms, req.options ?? {});
    else if (req.kind === 'sas') geom = await generateSAS(req.atoms, req.options ?? {});
    else geom = await generateSES(req.atoms, req.options ?? {});
    const res: SurfaceResponse = {
      id: req.id,
      ok: true,
      positions: geom.positions.buffer as ArrayBuffer,
      normals: geom.normals.buffer as ArrayBuffer,
      indices: geom.indices?.buffer as ArrayBuffer | undefined,
      atomIndex: geom.atomIndex?.buffer as ArrayBuffer | undefined,
    };
    const transfers = [res.positions, res.normals];
    if (res.indices) transfers.push(res.indices);
    if (res.atomIndex) transfers.push(res.atomIndex);
    scope.postMessage(res, transfers);
  } catch (e) {
    scope.postMessage({ id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) } satisfies SurfaceResponse);
  }
}

(self as unknown as DedicatedWorkerGlobalScope).onmessage = (ev: MessageEvent<SurfaceRequest>) => {
  void handle(ev.data);
};
