import { generateVDW, generateSAS, generateSES, type Atom, type SurfaceOptions, type SurfaceGeometry } from './index';

export type SurfaceKind = 'vdw' | 'sas' | 'ses';

export interface SurfaceRequest {
  kind: SurfaceKind;
  atoms: Atom[];
  options?: SurfaceOptions;
}

export type SurfaceResponse =
  | {
      ok: true;
      positions: ArrayBuffer;
      normals: ArrayBuffer;
      indices?: ArrayBuffer;
      atomIndex?: ArrayBuffer;
    }
  | { ok: false; error: string };

async function handle(req: SurfaceRequest): Promise<SurfaceResponse> {
  try {
    let geom: SurfaceGeometry;
    if (req.kind === 'vdw') geom = await generateVDW(req.atoms, req.options ?? {});
    else if (req.kind === 'sas') geom = await generateSAS(req.atoms, req.options ?? {});
    else geom = await generateSES(req.atoms, req.options ?? {});
    const transfers: ArrayBuffer[] = [geom.positions.buffer, geom.normals.buffer];
    const res: SurfaceResponse = {
      ok: true,
      positions: geom.positions.buffer,
      normals: geom.normals.buffer,
      indices: geom.indices ? geom.indices.buffer : undefined,
      atomIndex: geom.atomIndex ? geom.atomIndex.buffer : undefined,
    };
    if (geom.indices) transfers.push(geom.indices.buffer);
    if (geom.atomIndex) transfers.push(geom.atomIndex.buffer);
    (self as DedicatedWorkerGlobalScope).postMessage(res, transfers);
    return res;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const res: SurfaceResponse = { ok: false, error: msg };
    (self as DedicatedWorkerGlobalScope).postMessage(res);
    return res;
  }
}

(self as DedicatedWorkerGlobalScope).onmessage = (ev: MessageEvent<SurfaceRequest>) => {
  void handle(ev.data);
};
