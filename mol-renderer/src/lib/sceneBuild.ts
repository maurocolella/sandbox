/*
 Title: sceneBuild
 Description: Runs atom or bond instance-data builds in a worker. Only the latest request matters: a new
 request terminates a busy worker (the build is synchronous) and rejects the previous one with AbortError.
*/
import type { LodBuildProgress, LodData } from "./instancedLod";
import type { LodAtomsInput, LodBondsInput } from "./lodAtoms";

export type SceneBuildRequest =
  | { id: number; kind: "atoms"; input: LodAtomsInput }
  | { id: number; kind: "bonds"; input: LodBondsInput };
export type SceneBuildResponse =
  | { id: number; ok: true; data: LodData }
  | { id: number; ok: false; error: string }
  | { id: number; progress: LodBuildProgress };

type Pending = { id: number; resolve: (d: LodData) => void; reject: (e: unknown) => void; onProgress?: (p: LodBuildProgress) => void };

export class SceneBuildClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending: Pending | null = null;

  /** Build instance data; the input arrays are copied to the worker, not transferred. */
  build(kind: "atoms", input: LodAtomsInput, onProgress?: (p: LodBuildProgress) => void): Promise<LodData>;
  build(kind: "bonds", input: LodBondsInput, onProgress?: (p: LodBuildProgress) => void): Promise<LodData>;
  build(kind: "atoms" | "bonds", input: LodAtomsInput | LodBondsInput, onProgress?: (p: LodBuildProgress) => void): Promise<LodData> {
    this.cancel();
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<LodData>((resolve, reject) => {
      this.pending = { id, resolve, reject, ...(onProgress ? { onProgress } : {}) };
      worker.postMessage({ id, kind, input } as SceneBuildRequest);
    });
  }

  cancel(): void {
    if (!this.pending) return;
    const { reject } = this.pending;
    this.pending = null;
    this.worker?.terminate();
    this.worker = null;
    reject(new DOMException("scene build aborted", "AbortError"));
  }

  dispose(): void {
    this.cancel();
    this.worker?.terminate();
    this.worker = null;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./sceneBuild.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (ev: MessageEvent<SceneBuildResponse>) => {
      const res = ev.data;
      if (!this.pending || this.pending.id !== res.id) return;
      if ("progress" in res) { this.pending.onProgress?.(res.progress); return; }
      const { resolve, reject } = this.pending;
      this.pending = null;
      if (res.ok) resolve(res.data); else reject(new Error(res.error));
    };
    worker.onerror = (ev) => {
      const p = this.pending;
      this.pending = null;
      this.worker?.terminate();
      this.worker = null;
      p?.reject(new Error(ev.message || "scene build worker failed"));
    };
    this.worker = worker;
    return worker;
  }
}
