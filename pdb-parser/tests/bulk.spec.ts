import { describe, it, expect } from "vitest";
import { Worker } from "node:worker_threads";
import { cpus } from "node:os";
import { readdirSync, readFileSync, Dirent, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { parsePdbToMolScene, type ParseOptions } from "../dist/index.js";

function isPdbFile(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".pdb");
}

function listPdbFiles(rootDir: string): string[] {
  const out: string[] = [];
  const stack: string[] = [rootDir];

  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      // If a directory can't be read, record it as a logical failure and continue
      // but since this is an unexpected state, surface it clearly
      throw new Error(`Cannot read directory: ${dir}. ${e instanceof Error ? e.message : String(e)}`);
    }

    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile() && isPdbFile(full)) {
        out.push(full);
      }
    }
  }

  return out;
}

function parseOne(path: string, opts: ParseOptions): void {
  const text = readFileSync(path, "utf8");
  // Keep options conservative for performance; CONECT-only is the default
  parsePdbToMolScene(text, opts);
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.stack || err.message || err.name;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

interface Failure {
  file: string;
  error: string;
}
interface PoolResult {
  failures: Failure[];
  warnedFiles: number;
  categoryFiles: { altLoc: number; heuristic: number; missingCoords: number; other: number };
}

// Minimal worker code to parse and validate a single file; reused by a persistent worker via messages
// Receives workerData: { parserModulePath: string; options: ParseOptions }
// Receives messages: string (absolute filepath)
const WORKER_CODE = `
  const { parentPort, workerData } = require('node:worker_threads');
  const { readFileSync } = require('node:fs');
  const { pathToFileURL } = require('node:url');

  const { parserModulePath, options } = workerData;

  const modUrl = pathToFileURL(parserModulePath).href;
  let parsePdbToMolScene;
  let ready = false;
  import(modUrl)
    .then((mod) => {
      parsePdbToMolScene = mod.parsePdbToMolScene;
      ready = true;
    })
    .catch((e) => {
      const msg = e && e.stack ? e.stack : (e && e.message ? e.message : String(e));
      if (parentPort) parentPort.postMessage({ ok: false, file: '(init)', error: msg });
    });

  if (!parentPort) throw new Error('No parentPort');

  function validateScene(scene) {
    const reasons = [];
    try {
      if (!scene || !scene.atoms) {
        reasons.push('no-scene');
        return reasons;
      }
      const atoms = scene.atoms;
      const count = (atoms.count | 0);
      if (!(count > 0)) reasons.push('atoms=0');
      if (!atoms.positions || atoms.positions.length !== count * 3) reasons.push('positions');
      if (!atoms.radii || atoms.radii.length !== count) reasons.push('radii');
      if (!atoms.element || atoms.element.length !== count) reasons.push('element');
      if (!atoms.chainIndex || atoms.chainIndex.length !== count) reasons.push('chainIndex');
      if (!atoms.residueIndex || atoms.residueIndex.length !== count) reasons.push('residueIndex');

      if (scene.bonds) {
        const bc = (scene.bonds.count | 0);
        if (bc > 0) {
          if (!scene.bonds.indexA || scene.bonds.indexA.length !== bc) reasons.push('bonds.indexA');
          if (!scene.bonds.indexB || scene.bonds.indexB.length !== bc) reasons.push('bonds.indexB');
          if (scene.bonds.order && scene.bonds.order.length !== bc) reasons.push('bonds.order');
        }
      }

      if (scene.backbone) {
        const pos = scene.backbone.positions;
        const seg = scene.backbone.segments;
        if (!pos || pos.length < 6 || (pos.length % 3) !== 0) reasons.push('backbone.positions');
        if (!seg || (seg.length % 2) !== 0) reasons.push('backbone.segments');
      }
    } catch (e) {
      reasons.push('validation-error');
    }
    return reasons;
  }

  parentPort.on('message', (file) => {
    try {
      if (!ready || !parsePdbToMolScene) throw new Error('Parser not initialized');
      const text = readFileSync(file, 'utf8');
      let scene = parsePdbToMolScene(text, options);
      const warningsCount = Array.isArray(scene && scene.metadata && scene.metadata.warnings)
        ? scene.metadata.warnings.length
        : 0;
      const cats = { altLoc: false, heuristic: false, missingCoords: false, other: false };
      if (warningsCount > 0) {
        const arr = (scene && scene.metadata && scene.metadata.warnings) || [];
        for (const msg of arr) {
          if (typeof msg !== 'string') { cats.other = true; continue; }
          if (msg.includes('AltLoc resolution')) cats.altLoc = true;
          else if (msg.startsWith('Heuristic bonding created')) cats.heuristic = true;
          else if (msg.includes('missing coordinates')) cats.missingCoords = true;
          else cats.other = true;
        }
      }
      const reasons = validateScene(scene);
      if (reasons.length > 0) {
        parentPort.postMessage({ ok: false, file, error: 'semantic', reasons, warningsCount, categories: cats });
      } else {
        parentPort.postMessage({ ok: true, file, warningsCount, categories: cats });
      }
      // Hint GC to reduce long-run memory pressure
      try { scene = null; if (global && typeof global.gc === 'function') global.gc(); } catch {}
    } catch (e) {
      const msg = e && e.stack ? e.stack : (e && e.message ? e.message : String(e));
      parentPort.postMessage({ ok: false, file, error: msg });
    }
  });
`;

async function runPool(files: string[], opts: ParseOptions, fixturesRoot: string, concurrency: number): Promise<PoolResult> {
  const failures: Failure[] = [];
  let warnedFiles = 0;
  const categoryFiles = { altLoc: 0, heuristic: 0, missingCoords: 0, other: 0 };
  if (files.length === 0) return { failures, warnedFiles, categoryFiles };

  const parserModulePath = join(__dirname, "..", "dist", "index.js");
  const total = files.length;
  let nextIndex = 0;

  const currentFile = new WeakMap<Worker, string>();

  const assign = (w: Worker): boolean => {
    if (nextIndex >= total) return false;
    const file = files[nextIndex++]!;
    currentFile.set(w, file);
    w.postMessage(file);
    return true;
  };

  await new Promise<void>((resolve) => {
    let active = Math.min(concurrency, total);

    const makeWorker = (): Worker => {
      const worker = new Worker(WORKER_CODE, {
        eval: true,
        workerData: { parserModulePath, options: opts },
      });

      worker.on("message", (msg: { ok: boolean; file: string; error?: string; reasons?: string[]; warningsCount?: number; categories?: { altLoc?: boolean; heuristic?: boolean; missingCoords?: boolean; other?: boolean } }) => {
        if (typeof msg.warningsCount === 'number' && msg.warningsCount > 0) {
          warnedFiles += 1;
          const c = msg.categories || {};
          if (c.altLoc) categoryFiles.altLoc += 1;
          if (c.heuristic) categoryFiles.heuristic += 1;
          if (c.missingCoords) categoryFiles.missingCoords += 1;
          if (c.other) categoryFiles.other += 1;
        }
        if (!msg.ok) {
          const rel = relative(fixturesRoot, msg.file);
          // eslint-disable-next-line no-console
          if (msg.error === 'semantic' && Array.isArray(msg.reasons) && msg.reasons.length > 0) {
            console.error(`[FAIL] ${rel}: semantic - ${msg.reasons.join(',')}`);
            failures.push({ file: rel, error: `semantic:${msg.reasons.join(',')}` });
          } else {
            console.error(`[FAIL] ${rel}: ${msg.error ?? "unknown error"}`);
            failures.push({ file: rel, error: msg.error ?? "unknown error" });
          }
        }
        if (!assign(worker)) {
          // no more work for this worker
          void worker.terminate();
          active -= 1;
          if (active === 0) resolve();
        }
      });

      worker.on("error", (err: unknown) => {
        const cf = currentFile.get(worker);
        const rel = cf ? relative(fixturesRoot, cf) : "(no-file)";
        const msg = formatError(err);
        // eslint-disable-next-line no-console
        console.error(`[FAIL] ${rel}: ${msg}`);
        if (cf) failures.push({ file: rel, error: msg });
        if (!assign(worker)) {
          void worker.terminate();
          active -= 1;
          if (active === 0) resolve();
        }
      });

      return worker;
    };

    // Start workers and seed one task each
    for (let i = 0; i < active; i++) {
      const w = makeWorker();
      assign(w);
    }
  });

  return { failures, warnedFiles, categoryFiles };
}

// Bulk-test all fixtures under fixtures/pdb
// Ensure the symlink exists: pdb-parser/fixtures -> ../fixtures (top-level)
// If missing, fail fast with a clear message.
describe("bulk-parse fixtures/pdb", () => {
  const fixturesRoot = join(__dirname, "..", "fixtures", "pdb");

  it("parses all .pdb files without throwing and passes semantic checks (two bond policies)", async () => {
    if (!existsSync(fixturesRoot)) {
      throw new Error(
        `fixtures/pdb not found at ${fixturesRoot}. Ensure a symlink exists: 'ln -s ../fixtures fixtures' inside pdb-parser/`,
      );
    }

    const files = listPdbFiles(fixturesRoot);
    console.log(`[bulk] Found ${files.length} .pdb files in ${fixturesRoot}`);

    const opts: ParseOptions = {
      // default bonding policy is 'conect-only' which is faster for bulk validation
      bondPolicy: "conect-only",
      altLocPolicy: "occupancy",
      modelSelection: 1,
    };

    const requestedWorkers = Number(process.env.BULK_WORKERS || "");
    const defaultWorkers = Math.max(1, cpus().length);
    const maxWorkers = Number.isFinite(requestedWorkers) && requestedWorkers > 0 ? requestedWorkers : defaultWorkers;
    // eslint-disable-next-line no-console
    console.log(`[bulk] Using ${maxWorkers} worker threads`);

    // Pass 1: conect-only (fast)
    const resA = await runPool(files, opts, fixturesRoot, maxWorkers);
    const successCountA = files.length - resA.failures.length;
    // eslint-disable-next-line no-console
    console.log(`[bulk][conect-only] Completed. Success: ${successCountA}, Failures: ${resA.failures.length}, FilesWithWarnings: ${resA.warnedFiles}`);
    // eslint-disable-next-line no-console
    console.log(`[bulk][conect-only] Warning categories (files): altLoc=${resA.categoryFiles.altLoc}, heuristic=${resA.categoryFiles.heuristic}, missingCoords=${resA.categoryFiles.missingCoords}, other=${resA.categoryFiles.other}`);

    // Pass 2: conect+heuristic (exercise neighbor search) — process in chunks to mitigate long-run memory pressure
    const optsHeur: ParseOptions = { ...opts, bondPolicy: "conect+heuristic" };
    const heurChunkSizeEnv = Number(process.env.BULK_HEUR_CHUNK_SIZE || "10000");
    const heurChunkSize = Number.isFinite(heurChunkSizeEnv) && heurChunkSizeEnv > 0 ? heurChunkSizeEnv : 10000;
    let aggBWarned = 0;
    let aggBFailures: Failure[] = [];
    const aggBCats = { altLoc: 0, heuristic: 0, missingCoords: 0, other: 0 };
    for (let start = 0; start < files.length; start += heurChunkSize) {
      const end = Math.min(files.length, start + heurChunkSize);
      const chunk = files.slice(start, end);
      // eslint-disable-next-line no-console
      console.log(`[bulk] Heuristic chunk ${start}-${end - 1} (${chunk.length} files)`);
      const chunkRes = await runPool(chunk, optsHeur, fixturesRoot, maxWorkers);
      aggBWarned += chunkRes.warnedFiles;
      aggBFailures = aggBFailures.concat(chunkRes.failures);
      aggBCats.altLoc += chunkRes.categoryFiles.altLoc;
      aggBCats.heuristic += chunkRes.categoryFiles.heuristic;
      aggBCats.missingCoords += chunkRes.categoryFiles.missingCoords;
      aggBCats.other += chunkRes.categoryFiles.other;
      // eslint-disable-next-line no-console
      console.log(`[bulk][heuristic][chunk] Success: ${chunk.length - chunkRes.failures.length}, Failures: ${chunkRes.failures.length}, FilesWithWarnings: ${chunkRes.warnedFiles}`);
    }
    const successCountB = files.length - aggBFailures.length;
    // eslint-disable-next-line no-console
    console.log(`[bulk][conect+heuristic] Completed. Success: ${successCountB}, Failures: ${aggBFailures.length}, FilesWithWarnings: ${aggBWarned}`);
    // eslint-disable-next-line no-console
    console.log(`[bulk][conect+heuristic] Warning categories (files): altLoc=${aggBCats.altLoc}, heuristic=${aggBCats.heuristic}, missingCoords=${aggBCats.missingCoords}, other=${aggBCats.other}`);

    // Final assertion across both passes
    if (resA.failures.length > 0 || aggBFailures.length > 0) {
      const failedA = resA.failures.map((f) => f.file);
      const failedB = aggBFailures.map((f) => f.file);
      expect({ conectOnlyFailed: failedA, heuristicFailed: failedB }).toEqual({ conectOnlyFailed: [], heuristicFailed: [] });
    } else {
      expect(true).toBe(true);
    }
  }, 1_800_000); // allow up to 30 minutes for very large corpora
});
