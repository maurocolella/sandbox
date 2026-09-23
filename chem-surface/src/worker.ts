import { generateVDW, generateSAS, generateSES, type Atom, type SurfaceOptions, type SurfaceGeometry, type SurfaceKind } from './index.js';

export type { SurfaceKind } from './index.js';

export interface SurfaceRequest {
  id: number;
  kind: SurfaceKind;
  atoms: Atom[];
  options?: Omit<SurfaceOptions, 'signal'>; // AbortSignal cannot cross the worker boundary
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
  | { id: number; ok: false; error: string };

async function handle(req: SurfaceRequest): Promise<void> {
  const scope = self as unknown as DedicatedWorkerGlobalScope;
  try {
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
