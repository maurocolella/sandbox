/*
 Title: LigandLayer
 Description: Ligands (non-polymer residues of two or more atoms, other than water and common
 crystallisation additives, as BioLiP excludes them) as ball-and-stick with wheat
 carbons, labelled "NAME chain seq", in every representation; a click on its label or atoms reports it. Drawn slightly larger than the regular atoms
 and bonds so they cover them; picking and hover still go through the regular atoms.
*/
import { useEffect, useMemo } from "react";
import { Html } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { MolScene } from "pdb-parser";
import { buildBallAndStick, disposeGroup } from "../lib/ballAndStick";

const WATER = new Set(["HOH", "WAT", "DOD", "H2O"]);
// Buffers, cryoprotectants, precipitants and small anions from crystallisation, not biological ligands
const ADDITIVES = new Set([
  "SO4", "PO4", "NO3", "SCN", "CO3", "AZI", "ACT", "ACY", "FMT", "CIT", "FLC", "TAR", "MLI", "MLA", "SIN",
  "GOL", "EDO", "PEG", "PGE", "PG4", "1PE", "P6G", "12P", "15P", "2PE", "MPD", "MRD", "BU1", "BU3", "IPA", "EOH",
  "MOH", "DMS", "ACM", "TRS", "MES", "EPE", "BME", "DTT", "IMD", "NH4",
]);
// PyMOL "wheat": outside both PyMOL's chain colour cycle (so ligands stand out from ribbons) and element colours
const CARBON = new THREE.Color(0xfcd1a5);
const BALL_OVER = 1.07; // ligand balls just cover the regular spheres (same radius scale)
const STICK_RADIUS = 0.12; // regular bonds are 0.06
const MAX_LABELS = 100;
// Inline styles (this package has no CSS of its own); the host's UI tokens apply when defined
const LABEL_STYLE: React.CSSProperties = {
  transform: "translateY(-1.6em)", whiteSpace: "nowrap", padding: "1px 6px", borderRadius: 4,
  font: "11px ui-monospace, SFMono-Regular, Menlo, monospace",
  color: "var(--ui-fg, #e4e4e7)", background: "var(--ui-bg, rgb(24 24 27 / 0.55))",
  border: "1px solid var(--ui-border, rgb(255 255 255 / 0.1))", backdropFilter: "blur(4px)",
};

export interface LigandRef { compId: string; chain: string; seq: number; label: string }
interface Ligand extends LigandRef { center: THREE.Vector3 }

/** Ligand atoms (grouped by ligand) and, per atom, the index of its ligand. */
function findLigands(scene: MolScene) {
  const residues = scene.tables?.residues ?? [], chains = scene.tables?.chains ?? [];
  const ri = scene.atoms.residueIndex;
  if (!ri) return { atoms: [] as number[], ligandOf: [] as number[], ligands: [] as Ligand[] };
  const polymer = new Uint8Array(residues.length);
  for (const seg of scene.tables?.chainSegments ?? []) for (let r = seg.startResidue; r <= seg.endResidue; r++) polymer[r] = 1;
  const byResidue = new Map<number, number[]>();
  for (let i = 0; i < scene.atoms.count; i++) {
    const r = ri[i]!;
    const name = residues[r]?.name ?? "";
    if (polymer[r] || WATER.has(name) || ADDITIVES.has(name)) continue;
    const list = byResidue.get(r);
    if (list) list.push(i); else byResidue.set(r, [i]);
  }
  const atoms: number[] = [], ligandOf: number[] = [], ligands: Ligand[] = [];
  const P = scene.atoms.positions;
  for (const [r, list] of byResidue) {
    if (list.length < 2) continue; // ions
    const center = new THREE.Vector3();
    for (const i of list) { atoms.push(i); ligandOf.push(ligands.length); center.x += P[i * 3]!; center.y += P[i * 3 + 1]!; center.z += P[i * 3 + 2]!; }
    center.divideScalar(list.length);
    const res = residues[r]!, chain = chains[res.chain ?? -1]?.id ?? "";
    ligands.push({ compId: res.name, chain, seq: res.seq, label: `${res.name} ${chain} ${res.seq}`.replace(/\s+/g, " "), center });
  }
  return { atoms, ligandOf, ligands };
}

const refOf = (l: Ligand): LigandRef => ({ compId: l.compId, chain: l.chain, seq: l.seq, label: l.label });

export function LigandLayer({ scene, radiusScale, onLigandClick }: { scene: MolScene | null; radiusScale: number; onLigandClick?: (ligand: LigandRef) => void }) {
  const invalidate = useThree((s) => s.invalidate);
  const { group, balls, ligandOf, ligands } = useMemo(() => {
    if (!scene) return { group: new THREE.Group(), balls: null, ligandOf: [] as number[], ligands: [] as Ligand[] };
    const { atoms, ligandOf, ligands } = findLigands(scene);
    if (atoms.length === 0) return { group: new THREE.Group(), balls: null, ligandOf, ligands };
    const P = scene.atoms.positions, R = scene.atoms.radii, C = scene.atoms.colors, E = scene.atoms.element;
    // Ligand atoms as their own small set: positions and bonds re-indexed
    const local = new Int32Array(scene.atoms.count).fill(-1);
    atoms.forEach((i, k) => { local[i] = k; });
    const positions = new Float32Array(atoms.length * 3);
    atoms.forEach((i, k) => positions.set([P[i * 3]!, P[i * 3 + 1]!, P[i * 3 + 2]!], k * 3));
    const bonds: [number, number][] = [];
    const b = scene.bonds;
    for (let k = 0; b && k < b.count; k++) {
      const x = local[b.indexA[k]!]!, y = local[b.indexB[k]!]!;
      if (x >= 0 && y >= 0) bonds.push([x, y]);
    }
    const { group, balls } = buildBallAndStick({
      positions, bonds, stickRadius: STICK_RADIUS,
      radius: (k) => (R?.[atoms[k]!] ?? 1.5) * radiusScale * BALL_OVER,
      color: (k, out) => {
        const i = atoms[k]!;
        return E?.[i] === 6 || !C ? out.copy(CARBON) : out.setRGB(C[i * 3]! / 255, C[i * 3 + 1]! / 255, C[i * 3 + 2]! / 255);
      },
    });
    return { group, balls, ligandOf, ligands };
  }, [scene, radiusScale]);

  useEffect(() => {
    invalidate();
    return () => disposeGroup(group);
  }, [group, invalidate]);

  return (
    <>
      <primitive
        object={group}
        onClick={(e: { delta: number; object: THREE.Object3D; instanceId?: number; stopPropagation: () => void }) => {
          // Ignore the end of an orbit drag
          if (!onLigandClick || e.object !== balls || e.instanceId === undefined || e.delta > 4) return;
          e.stopPropagation();
          onLigandClick(refOf(ligands[ligandOf[e.instanceId]!]!));
        }}
      />
      {ligands.length <= MAX_LABELS && ligands.map((l, k) => (
        <Html key={k} position={l.center} center zIndexRange={[5, 0]} style={{ pointerEvents: onLigandClick ? "auto" : "none" }}>
          <div
            style={{ ...LABEL_STYLE, cursor: onLigandClick ? "pointer" : undefined }}
            onClick={() => onLigandClick?.(refOf(l))}
          >
            {l.label}
          </div>
        </Html>
      ))}
    </>
  );
}
