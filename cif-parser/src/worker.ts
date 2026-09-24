/// <reference lib="webworker" />
/**
 * Worker entry: parse mmCIF bytes off the main thread and post the MolScene back, transferring its typed
 * arrays; progress messages are posted along the way. Pair with MmcifWorkerClient.
 */
import { loadMmcif, type MmcifLoadOptions, type MmcifProgress } from "./mmcif.js";
import { transferablesOf, type MmcifWorkerRequest, type MmcifWorkerResponse } from "./workerProtocol.js";

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = (ev: MessageEvent<MmcifWorkerRequest>) => {
  const { id, bytes, options } = ev.data;
  // Progress at most every 100 ms
  let last = 0;
  const onProgress = (progress: MmcifProgress) => {
    const now = performance.now();
    if (now - last < 100) return;
    last = now;
    scope.postMessage({ id, progress } satisfies MmcifWorkerResponse);
  };
  try {
    const scene = loadMmcif(new Uint8Array(bytes), options as MmcifLoadOptions, onProgress);
    scope.postMessage({ id, ok: true, scene } satisfies MmcifWorkerResponse, transferablesOf(scene));
  } catch (e) {
    scope.postMessage({ id, ok: false, error: e instanceof Error ? e.message : String(e) } satisfies MmcifWorkerResponse);
  }
};
