/// <reference lib="webworker" />
/**
 * Worker entry: parse mmCIF bytes off the main thread and post the MolScene back, transferring its typed
 * arrays. Pair with MmcifWorkerClient.
 */
import { loadMmcif, type MmcifLoadOptions } from "./mmcif.js";
import { transferablesOf, type MmcifWorkerRequest, type MmcifWorkerResponse } from "./workerProtocol.js";

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = (ev: MessageEvent<MmcifWorkerRequest>) => {
  const { id, bytes, options } = ev.data;
  try {
    const scene = loadMmcif(new Uint8Array(bytes), options as MmcifLoadOptions);
    scope.postMessage({ id, ok: true, scene } satisfies MmcifWorkerResponse, transferablesOf(scene));
  } catch (e) {
    scope.postMessage({ id, ok: false, error: e instanceof Error ? e.message : String(e) } satisfies MmcifWorkerResponse);
  }
};
