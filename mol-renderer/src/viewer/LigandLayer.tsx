/*
 Title: LigandLayer
 Description: Ligands (non-polymer residues of two or more atoms, other than water and common
 crystallisation additives, as BioLiP excludes them) as ball-and-stick with green
 carbons, labelled "NAME chain seq", in every representation. Drawn slightly larger than the regular atoms
 and bonds so they cover them; picking and hover still go through the regular atoms.
*/
import { useEffect, useMemo } from "react";
import { Html } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { MolScene } from "pdb-parser";

const WATER = new Set(["HOH", "WAT", "DOD", "H2O"]);
// Buffers, cryoprotectants, precipitants and small anions from crystallisation, not biological ligands
const ADDITIVES = new Set([
  "SO4", "PO4", "NO3", "SCN", "CO3", "AZI", "ACT", "ACY", "FMT", "CIT", "FLC", "TAR", "MLI", "MLA", "SIN",
  "GOL", "EDO", "PEG", "PGE", "PG4", "1PE", "P6G", "12P", "15P", "2PE", "MPD", "MRD", "BU1", "BU3", "IPA", "EOH",
  "MOH", "DMS", "ACM", "TRS", "MES", "EPE", "BME", "DTT", "IMD", "NH4",
]);
const CARBON = new THREE.Color(0x33cc33); // PyMOL's ligand green
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

interface Ligand { label: string; center: THREE.Vector3 }

function findLigands(scene: MolScene) {
  const residues = scene.tables?.residues ?? [], chains = scene.tables?.chains ?? [];
  const ri = scene.atoms.residueIndex;
  if (!ri) return { atoms: [] as number[], ligands: [] as Ligand[] };
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
  const atoms: number[] = [], ligands: Ligand[] = [];
  const P = scene.atoms.positions;
  for (const [r, list] of byResidue) {
    if (list.length < 2) continue; // ions
    const center = new THREE.Vector3();
    for (const i of list) { atoms.push(i); center.x += P[i * 3]!; center.y += P[i * 3 + 1]!; center.z += P[i * 3 + 2]!; }
    center.divideScalar(list.length);
    const res = residues[r]!;
    ligands.push({ label: `${res.name} ${chains[res.chain ?? -1]?.id ?? ""} ${res.seq}`.replace(/\s+/g, " "), center });
  }
  return { atoms, ligands };
}

export function LigandLayer({ scene, radiusScale }: { scene: MolScene | null; radiusScale: number }) {
  const invalidate = useThree((s) => s.invalidate);
  const { group, ligands } = useMemo(() => {
    const group = new THREE.Group();
    if (!scene) return { group, ligands: [] as Ligand[] };
    const { atoms, ligands } = findLigands(scene);
    if (atoms.length === 0) return { group, ligands };
    const P = scene.atoms.positions, R = scene.atoms.radii, C = scene.atoms.colors, E = scene.atoms.element;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), color = new THREE.Color();

    const balls = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 3), new THREE.MeshStandardMaterial({ roughness: 0.4 }), atoms.length);
    atoms.forEach((i, k) => {
      const r = (R?.[i] ?? 1.5) * radiusScale * BALL_OVER;
      balls.setMatrixAt(k, m.compose(p.set(P[i * 3]!, P[i * 3 + 1]!, P[i * 3 + 2]!), q.identity(), s.set(r, r, r)));
      if (E?.[i] === 6 || !C) color.copy(CARBON);
      else color.setRGB(C[i * 3]! / 255, C[i * 3 + 1]! / 255, C[i * 3 + 2]! / 255);
      balls.setColorAt(k, color);
    });
    group.add(balls);

    // Sticks for bonds inside ligands; each half takes its atom's colour
    const isLigand = new Uint8Array(scene.atoms.count);
    for (const i of atoms) isLigand[i] = 1;
    const halves: [number, number][] = [];
    const b = scene.bonds;
    for (let k = 0; b && k < b.count; k++) {
      const a = b.indexA[k]!, c = b.indexB[k]!;
      if (isLigand[a] && isLigand[c]) halves.push([a, c], [c, a]);
    }
    if (halves.length > 0) {
      const sticks = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 12, 1, true), new THREE.MeshStandardMaterial({ roughness: 0.4 }), halves.length);
      const up = new THREE.Vector3(0, 1, 0), from = new THREE.Vector3(), to = new THREE.Vector3(), dir = new THREE.Vector3();
      halves.forEach(([a, c], k) => {
        from.set(P[a * 3]!, P[a * 3 + 1]!, P[a * 3 + 2]!);
        to.set(P[c * 3]!, P[c * 3 + 1]!, P[c * 3 + 2]!).add(from).multiplyScalar(0.5); // to the bond's middle
        dir.subVectors(to, from);
        const len = dir.length();
        q.setFromUnitVectors(up, dir.normalize());
        sticks.setMatrixAt(k, m.compose(p.addVectors(from, to).multiplyScalar(0.5), q, s.set(STICK_RADIUS, len, STICK_RADIUS)));
        if (E?.[a] === 6 || !C) color.copy(CARBON);
        else color.setRGB(C[a * 3]! / 255, C[a * 3 + 1]! / 255, C[a * 3 + 2]! / 255);
        sticks.setColorAt(k, color);
      });
      group.add(sticks);
    }
    group.traverse((o) => { o.raycast = () => {}; });
    return { group, ligands };
  }, [scene, radiusScale]);

  useEffect(() => {
    invalidate();
    return () => group.traverse((o) => {
      if (o instanceof THREE.Mesh) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); }
    });
  }, [group, invalidate]);

  return (
    <>
      <primitive object={group} />
      {ligands.length <= MAX_LABELS && ligands.map((l, k) => (
        <Html key={k} position={l.center} center zIndexRange={[5, 0]} style={{ pointerEvents: "none" }}>
          <div style={LABEL_STYLE}>{l.label}</div>
        </Html>
      ))}
    </>
  );
}
