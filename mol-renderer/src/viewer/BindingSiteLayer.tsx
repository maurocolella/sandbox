/*
 Title: BindingSiteLayer
 Description: The binding site of a ligand: polymer residues with any atom within CUTOFF of it, as licorice
 sticks (grey carbons, element colours otherwise) with a label at each residue's CA.
*/
import { useEffect, useMemo } from "react";
import { Html } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { MolScene } from "pdb-parser";
import { ligandAtoms, type LigandKey } from "../lib/interactions";

const CUTOFF = 5; // Å
const RADIUS = 0.1; // Å, sticks and joints
const CARBON = new THREE.Color(0xb4b4b4);
const LABEL_STYLE: React.CSSProperties = {
  whiteSpace: "nowrap", padding: "0 4px", borderRadius: 3, font: "10px ui-monospace, SFMono-Regular, Menlo, monospace",
  color: "var(--ui-fg, #e4e4e7)", background: "var(--ui-bg, rgb(24 24 27 / 0.55))", opacity: 0.85,
};

/** Atoms of the polymer residues within CUTOFF of the ligand, and one label per residue. */
function siteOf(scene: MolScene, key: LigandKey) {
  const lig = ligandAtoms(scene, key);
  const residues = scene.tables?.residues ?? [], ri = scene.atoms.residueIndex, P = scene.atoms.positions;
  if (lig.length === 0 || !ri) return { atoms: [] as number[], labels: [] as { text: string; at: THREE.Vector3 }[] };
  const polymer = new Uint8Array(residues.length);
  for (const seg of scene.tables?.chainSegments ?? []) for (let r = seg.startResidue; r <= seg.endResidue; r++) polymer[r] = 1;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const i of lig) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a]!, P[i * 3 + a]! - CUTOFF); hi[a] = Math.max(hi[a]!, P[i * 3 + a]! + CUTOFF); }
  const site = new Set<number>(), c2 = CUTOFF * CUTOFF;
  for (let j = 0; j < scene.atoms.count; j++) {
    const r = ri[j]!;
    if (!polymer[r] || site.has(r)) continue;
    const x = P[j * 3]!, y = P[j * 3 + 1]!, z = P[j * 3 + 2]!;
    if (x < lo[0]! || x > hi[0]! || y < lo[1]! || y > hi[1]! || z < lo[2]! || z > hi[2]!) continue;
    for (const i of lig) {
      const dx = x - P[i * 3]!, dy = y - P[i * 3 + 1]!, dz = z - P[i * 3 + 2]!;
      if (dx * dx + dy * dy + dz * dz <= c2) { site.add(r); break; }
    }
  }
  const atoms: number[] = [], labels: { text: string; at: THREE.Vector3 }[] = [];
  const names = scene.atoms.names ?? [];
  for (let j = 0; j < scene.atoms.count; j++) {
    if (!site.has(ri[j]!)) continue;
    atoms.push(j);
    if (names[j] === "CA") labels.push({ text: `${residues[ri[j]!]!.name} ${residues[ri[j]!]!.seq}`, at: new THREE.Vector3(P[j * 3]!, P[j * 3 + 1]!, P[j * 3 + 2]!) });
  }
  return { atoms, labels };
}

export function BindingSiteLayer({ scene, ligand }: { scene: MolScene | null; ligand: LigandKey | null }) {
  const invalidate = useThree((s) => s.invalidate);
  const { group, labels } = useMemo(() => {
    const group = new THREE.Group();
    if (!scene || !ligand) return { group, labels: [] };
    const { atoms, labels } = siteOf(scene, ligand);
    if (atoms.length === 0) return { group, labels };
    const P = scene.atoms.positions, C = scene.atoms.colors, E = scene.atoms.element;
    const colorOf = (i: number, out: THREE.Color) => (E?.[i] === 6 || !C ? out.copy(CARBON) : out.setRGB(C[i * 3]! / 255, C[i * 3 + 1]! / 255, C[i * 3 + 2]! / 255));
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), color = new THREE.Color();

    // Joints, so sticks meet cleanly
    const joints = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 2), new THREE.MeshStandardMaterial({ roughness: 0.4 }), atoms.length);
    atoms.forEach((i, k) => {
      joints.setMatrixAt(k, m.compose(p.set(P[i * 3]!, P[i * 3 + 1]!, P[i * 3 + 2]!), q.identity(), s.set(RADIUS, RADIUS, RADIUS)));
      joints.setColorAt(k, colorOf(i, color));
    });
    group.add(joints);

    // Bonds within the site; each half takes its atom's colour
    const inSite = new Uint8Array(scene.atoms.count);
    for (const i of atoms) inSite[i] = 1;
    const halves: [number, number][] = [];
    const b = scene.bonds;
    for (let k = 0; b && k < b.count; k++) {
      const x = b.indexA[k]!, y = b.indexB[k]!;
      if (inSite[x] && inSite[y]) halves.push([x, y], [y, x]);
    }
    if (halves.length > 0) {
      const sticks = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 10, 1, true), new THREE.MeshStandardMaterial({ roughness: 0.4 }), halves.length);
      const up = new THREE.Vector3(0, 1, 0), from = new THREE.Vector3(), to = new THREE.Vector3(), dir = new THREE.Vector3();
      halves.forEach(([x, y], k) => {
        from.set(P[x * 3]!, P[x * 3 + 1]!, P[x * 3 + 2]!);
        to.set(P[y * 3]!, P[y * 3 + 1]!, P[y * 3 + 2]!).add(from).multiplyScalar(0.5);
        dir.subVectors(to, from);
        const len = dir.length();
        q.setFromUnitVectors(up, dir.normalize());
        sticks.setMatrixAt(k, m.compose(p.addVectors(from, to).multiplyScalar(0.5), q, s.set(RADIUS, len, RADIUS)));
        sticks.setColorAt(k, colorOf(x, color));
      });
      group.add(sticks);
    }
    group.traverse((o) => { o.raycast = () => {}; });
    return { group, labels };
  }, [scene, ligand]);

  useEffect(() => {
    invalidate();
    return () => group.traverse((o) => {
      if (o instanceof THREE.Mesh) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); }
    });
  }, [group, invalidate]);

  return (
    <>
      <primitive object={group} />
      {labels.map((l, k) => (
        <Html key={k} position={l.at} center zIndexRange={[3, 0]} style={{ pointerEvents: "none" }}>
          <div style={LABEL_STYLE}>{l.text}</div>
        </Html>
      ))}
    </>
  );
}
