/*
 Title: sceneBuild.worker
 Description: Worker entry: computes atom or bond instance data (transforms, colors, hierarchy) off the main
 thread and posts it back, transferring its buffers; progress messages are posted along the way. Pair with
 SceneBuildClient.
*/
import { atomLodData, bondLodData } from "./lodAtoms";
import { lodDataTransferables, type LodBuildProgress } from "./instancedLod";
import type { SceneBuildRequest, SceneBuildResponse } from "./sceneBuild";

const scope = self as unknown as {
  postMessage(message: SceneBuildResponse, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<SceneBuildRequest>) => void) | null;
};

scope.onmessage = (ev) => {
  const req = ev.data;
  // Progress at most every 100 ms
  let last = 0;
  const onProgress = (progress: LodBuildProgress) => {
    const now = performance.now();
    if (now - last < 100) return;
    last = now;
    scope.postMessage({ id: req.id, progress });
  };
  try {
    const data = req.kind === "atoms" ? atomLodData(req.input, onProgress) : bondLodData(req.input, onProgress);
    scope.postMessage({ id: req.id, ok: true, data }, lodDataTransferables(data));
  } catch (e) {
    scope.postMessage({ id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
};
