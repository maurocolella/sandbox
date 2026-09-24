/*
 Title: loadStatusText
 Description: One-line loading status, e.g. "Step 3/6 · Parsing · 120 / 480 MB (25%)": loading stages
 (download, decompress, parse, atoms, bonds) then the renderer's build (instances, index, GPU upload).
*/
import type { SceneBuildStatus } from "mol-renderer";
import type { LoadStatus } from "./hooks/useMolScene";

const STEPS = 6;
const LOAD_STEPS: Record<LoadStatus["stage"], { step: number; label: string; unit: "MB" | "atoms" | "residues" }> = {
  download: { step: 1, label: "Downloading", unit: "MB" },
  decompress: { step: 2, label: "Decompressing", unit: "MB" },
  parse: { step: 3, label: "Parsing", unit: "MB" },
  atoms: { step: 4, label: "Reading atoms", unit: "atoms" },
  bonds: { step: 5, label: "Bonding residues", unit: "residues" },
};
const BUILD_LABELS: Record<SceneBuildStatus["stage"], (kind: SceneBuildStatus["kind"]) => string> = {
  instances: (kind) => `Building ${kind}`,
  tree: (kind) => `Indexing ${kind}`,
  upload: () => "Uploading to GPU",
};

function count(n: number, unit: string): string {
  if (unit === "MB") return (n / 1e6).toFixed(n < 1e7 ? 1 : 0);
  return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n.toLocaleString();
}

function line(step: number, label: string, unit: string, done?: number, total?: number): string {
  let text = `Step ${step}/${STEPS} · ${label}`;
  if (done !== undefined && total !== undefined && total > 0) {
    text += ` · ${count(done, unit)} / ${count(total, unit)} ${unit} (${Math.min(100, Math.floor((done / total) * 100))}%)`;
  } else if (done !== undefined) {
    text += ` · ${count(done, unit)} ${unit}`;
  }
  return text;
}

/** The status to show, or null when nothing is loading or building. */
export function loadStatusText(load: LoadStatus | null, build: SceneBuildStatus | null): string | null {
  if (load) {
    const s = LOAD_STEPS[load.stage];
    return line(s.step, s.label, s.unit, load.done, load.total);
  }
  if (build) {
    const unit = build.kind === "atoms" ? "atoms" : "bonds";
    return line(STEPS, BUILD_LABELS[build.stage](build.kind), unit, build.done, build.total);
  }
  return null;
}
