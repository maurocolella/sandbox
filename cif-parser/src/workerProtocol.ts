import type { MolScene } from "pdb-parser";
import type { MmcifLoadOptions, MmcifProgress } from "./mmcif.js";

export interface MmcifWorkerRequest { id: number; bytes: ArrayBuffer; options: MmcifLoadOptions }
export type MmcifWorkerResponse =
  | { id: number; ok: true; scene: MolScene }
  | { id: number; ok: false; error: string }
  | { id: number; progress: MmcifProgress };

/** Every distinct ArrayBuffer behind the scene's typed arrays (zero-copy transfer). */
export function transferablesOf(scene: MolScene): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  const visit = (v: unknown, depth: number) => {
    if (!v || typeof v !== "object" || depth > 4) return;
    if (ArrayBuffer.isView(v)) { if (v.buffer instanceof ArrayBuffer) out.add(v.buffer); return; }
    if (Array.isArray(v)) return; // tables of plain objects are cloned
    for (const x of Object.values(v)) visit(x, depth + 1);
  };
  visit(scene, 0);
  return [...out];
}

/**
 * Runs loadMmcif() in a worker. Only the latest request matters: a new request terminates a busy worker
 * (parsing is synchronous) and rejects the previous one with AbortError.
 */
export class MmcifWorkerClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending: { id: number; resolve: (s: MolScene) => void; reject: (e: unknown) => void; onProgress?: (p: MmcifProgress) => void } | null = null;

  constructor(private readonly createWorker: () => Worker) {}

  /** Parse `bytes` (decompressed mmCIF). The buffer is transferred, so the caller must not reuse it. */
  load(bytes: Uint8Array, options: MmcifLoadOptions = {}, onProgress?: (p: MmcifProgress) => void): Promise<MolScene> {
    this.cancel();
    const worker = this.ensureWorker();
    const id = this.nextId++;
    const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer
      ? bytes.buffer
      : bytes.slice().buffer;
    return new Promise<MolScene>((resolve, reject) => {
      this.pending = { id, resolve, reject, ...(onProgress ? { onProgress } : {}) };
      worker.postMessage({ id, bytes: buffer, options } satisfies MmcifWorkerRequest, [buffer]);
    });
  }

  cancel(): void {
    if (!this.pending) return;
    const { reject } = this.pending;
    this.pending = null;
    this.worker?.terminate();
    this.worker = null;
    reject(new DOMException("mmCIF load aborted", "AbortError"));
  }

  dispose(): void {
    this.cancel();
    this.worker?.terminate();
    this.worker = null;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = this.createWorker();
    worker.onmessage = (ev: MessageEvent<MmcifWorkerResponse>) => {
      const res = ev.data;
      if (!this.pending || this.pending.id !== res.id) return;
      if ("progress" in res) { this.pending.onProgress?.(res.progress); return; }
      const { resolve, reject } = this.pending;
      this.pending = null;
      if (res.ok) resolve(res.scene); else reject(new Error(res.error));
    };
    worker.onerror = (ev) => {
      const p = this.pending;
      this.pending = null;
      this.worker?.terminate();
      this.worker = null;
      p?.reject(new Error(ev.message || "mmCIF worker failed"));
    };
    this.worker = worker;
    return worker;
  }
}
