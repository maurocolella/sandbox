import { generateVDW, generateSAS, generateSES, type Atom, type SurfaceOptions, type SurfaceGeometry, type SurfaceKind } from './index.js';
import { findPockets, type PocketOptions } from './pockets.js';

export type { SurfaceKind } from './index.js';

export type SurfaceRequest =
  | {
      id: number;
      kind: SurfaceKind;
      atoms: Atom[];
      options?: Omit<SurfaceOptions, 'signal'>; // AbortSignal cannot cross the worker boundary
    }
  | { id: number; kind: 'pockets'; atoms: Atom[]; options?: Omit<PocketOptions, 'signal'> };

export interface PocketMessage {
  positions: ArrayBuffer;
  normals: ArrayBuffer;
  indices: ArrayBuffer;
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
  | { id: number; ok: false; error: string };

async function handle(req: SurfaceRequest): Promise<void> {
  const scope = self as unknown as DedicatedWorkerGlobalScope;
  try {
    if (req.kind === 'pockets') {
      const pockets = findPockets(req.atoms, req.options ?? {}).map((p) => ({
        ...p,
        positions: p.positions.buffer as ArrayBuffer,
        normals: p.normals.buffer as ArrayBuffer,
        indices: p.indices.buffer as ArrayBuffer,
      }));
      scope.postMessage({ id: req.id, ok: true, pockets } satisfies SurfaceResponse, pockets.flatMap((p) => [p.positions, p.normals, p.indices]));
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
