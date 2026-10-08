/*
 Title: interactions
 Description: Non-covalent contacts between a ligand and the polymer, after PLIP's geometric rules, adapted
 to structures without bond orders and usually without hydrogens:
 - Hydrogen bond: N/O pair within 3.5 Å (heavy atoms); with an explicit H, D-H...A >= 100°; otherwise the
   angle X-D...A at the donor (X a heavy neighbour) >= 90°. Either side may donate.
 - Salt bridge: opposite charge centres within 5.5 Å (Asp, Glu, Lys, Arg, His; ligand carboxylates,
   phosphates, sulfates/sulfonates, amines, amidines/guanidines).
 - π-stacking: ring centroids within 5.5 Å, parallel (normals within 30°) or T-shaped (90 ± 30°), offset
   <= 2.0 Å (Phe, Tyr, Trp, His; planar 5/6-rings of the ligand).
 - Hydrophobic: carbons bonded only to carbon (or hydrogen) within 4.0 Å; the closest pair per residue.
 - Metal coordination: a ligand metal and a polymer N/O/S within 3.0 Å.
 Covalently bonded pairs (covalent ligands) and pairs closer than 2.4 Å are not contacts; atoms bonded to a
 metal (e.g. haem's pyrrole N) don't hydrogen-bond, and rings through a metal aren't aromatic.
*/
import type { MolScene } from "pdb-parser";

export type InteractionType = "hbond" | "salt" | "pi" | "hydrophobic" | "metal";

export interface Interaction {
  type: InteractionType;
  /** Ligand-side and polymer-side points (atoms or group centres). */
  a: [number, number, number];
  b: [number, number, number];
  distance: number; // Å
  angle?: number; // degrees: H-bond angle, or angle between ring planes
  ligandAtom: string; // atom name, or group description
  residue: string; // e.g. "ASP A 189"
  residueAtom: string;
  detail?: string; // e.g. "parallel", "T-shaped"
}

export interface LigandKey { compId: string; chain: string; seq: number }

const WATER = new Set(["HOH", "WAT", "DOD", "H2O"]);
const METALS = new Set([12, 20, 25, 26, 27, 28, 29, 30]); // Mg, Ca, Mn, Fe, Co, Ni, Cu, Zn
const H = 1, C = 6, N = 7, O = 8, PHOS = 15, S = 16;
const SEARCH = 8; // Å around the ligand

type V = [number, number, number];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V) => Math.sqrt(dot(a, a));
const dist = (a: V, b: V) => len(sub(a, b));
const angleDeg = (a: V, b: V) => (Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (len(a) * len(b) || 1)))) * 180) / Math.PI;
const centroid = (ps: V[]): V => ps.reduce<V>((c, p) => [c[0] + p[0] / ps.length, c[1] + p[1] / ps.length, c[2] + p[2] / ps.length], [0, 0, 0]);

/** Unit normal of a ring (Newell's method) and its largest out-of-plane deviation. */
function ringPlane(ps: V[]): { normal: V; flat: number } {
  const c = centroid(ps);
  let n: V = [0, 0, 0];
  for (let i = 0; i < ps.length; i++) {
    const x = cross(sub(ps[i]!, c), sub(ps[(i + 1) % ps.length]!, c));
    n = [n[0] + x[0], n[1] + x[1], n[2] + x[2]];
  }
  const l = len(n) || 1;
  const normal: V = [n[0] / l, n[1] / l, n[2] / l];
  return { normal, flat: Math.max(...ps.map((p) => Math.abs(dot(sub(p, c), normal)))) };
}

const PROTEIN_RINGS: Record<string, string[][]> = {
  PHE: [["CG", "CD1", "CE1", "CZ", "CE2", "CD2"]],
  TYR: [["CG", "CD1", "CE1", "CZ", "CE2", "CD2"]],
  TRP: [["CD2", "CE2", "CZ2", "CH2", "CZ3", "CE3"], ["CG", "CD1", "NE1", "CE2", "CD2"]],
  HIS: [["CG", "ND1", "CE1", "NE2", "CD2"]],
};
const PROTEIN_CHARGES: Record<string, { sign: 1 | -1; atoms: string[] }> = {
  ASP: { sign: -1, atoms: ["OD1", "OD2"] },
  GLU: { sign: -1, atoms: ["OE1", "OE2"] },
  LYS: { sign: 1, atoms: ["NZ"] },
  ARG: { sign: 1, atoms: ["NE", "NH1", "NH2"] },
  HIS: { sign: 1, atoms: ["ND1", "NE2"] },
};

/** Ligand atoms (all residues matching the key), or an empty list. */
export function ligandAtoms(scene: MolScene, key: LigandKey): number[] {
  const residues = scene.tables?.residues ?? [], chains = scene.tables?.chains ?? [], ri = scene.atoms.residueIndex;
  if (!ri) return [];
  const out: number[] = [];
  for (let i = 0; i < scene.atoms.count; i++) {
    const r = residues[ri[i]!];
    if (r && r.name === key.compId && r.seq === key.seq && (chains[r.chain ?? -1]?.id ?? "") === key.chain) out.push(i);
  }
  return out;
}

export function findInteractions(scene: MolScene, key: LigandKey): Interaction[] {
  const lig = ligandAtoms(scene, key);
  if (lig.length === 0) return [];
  const P = scene.atoms.positions, E = scene.atoms.element, names = scene.atoms.names ?? [], ri = scene.atoms.residueIndex!;
  const residues = scene.tables?.residues ?? [], chains = scene.tables?.chains ?? [];
  const pos = (i: number): V => [P[i * 3]!, P[i * 3 + 1]!, P[i * 3 + 2]!];
  const el = (i: number) => E?.[i] ?? 0;
  const resLabel = (r: number) => { const x = residues[r]!; return `${x.name} ${chains[x.chain ?? -1]?.id ?? ""} ${x.seq}`.replace(/\s+/g, " "); };

  // Polymer atoms near the ligand
  const polymer = new Uint8Array(residues.length);
  for (const seg of scene.tables?.chainSegments ?? []) for (let r = seg.startResidue; r <= seg.endResidue; r++) polymer[r] = 1;
  const lo: V = [Infinity, Infinity, Infinity], hi: V = [-Infinity, -Infinity, -Infinity];
  for (const i of lig) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a]!, P[i * 3 + a]! - SEARCH); hi[a] = Math.max(hi[a]!, P[i * 3 + a]! + SEARCH); }
  const near: number[] = [];
  for (let i = 0; i < scene.atoms.count; i++) {
    if (!polymer[ri[i]!] || WATER.has(residues[ri[i]!]?.name ?? "")) continue;
    const x = P[i * 3]!, y = P[i * 3 + 1]!, z = P[i * 3 + 2]!;
    if (x >= lo[0] && x <= hi[0] && y >= lo[1] && y <= hi[1] && z >= lo[2] && z <= hi[2]) near.push(i);
  }

  // Bonded neighbours of the atoms involved
  const involved = new Set([...lig, ...near]);
  const nb = new Map<number, number[]>();
  const b = scene.bonds;
  for (let k = 0; b && k < b.count; k++) {
    const x = b.indexA[k]!, y = b.indexB[k]!;
    if (!involved.has(x) && !involved.has(y)) continue;
    (nb.get(x) ?? nb.set(x, []).get(x)!).push(y);
    (nb.get(y) ?? nb.set(y, []).get(y)!).push(x);
  }
  const neighbours = (i: number) => nb.get(i) ?? [];
  const bonded = (i: number, j: number) => neighbours(i).includes(j);
  const heavyNeighbours = (i: number) => neighbours(i).filter((j) => el(j) !== H);

  const out: Interaction[] = [];

  // Hydrogen bonds
  const onMetal = (i: number) => neighbours(i).some((j) => METALS.has(el(j)));
  const polar = (i: number) => (el(i) === N || el(i) === O) && !onMetal(i);
  const hbondAngle = (d: number, a: number): number | null => {
    const hs = neighbours(d).filter((j) => el(j) === H);
    if (hs.length > 0) {
      const best = Math.max(...hs.map((h) => angleDeg(sub(pos(d), pos(h)), sub(pos(a), pos(h)))));
      return best >= 100 ? best : null;
    }
    const xs = heavyNeighbours(d);
    if (xs.length === 0) return 180; // isolated donor: no geometry to check
    const worst = Math.min(...xs.map((x) => angleDeg(sub(pos(x), pos(d)), sub(pos(a), pos(d)))));
    return worst >= 90 ? worst : null;
  };
  for (const i of lig) {
    if (!polar(i)) continue;
    for (const j of near) {
      if (!polar(j)) continue;
      const d = dist(pos(i), pos(j));
      if (d > 3.5 || d < 2.4 || bonded(i, j)) continue;
      // Either may donate: keep the better geometry
      const angle = Math.max(hbondAngle(i, j) ?? -1, hbondAngle(j, i) ?? -1);
      if (angle < 0) continue;
      out.push({ type: "hbond", a: pos(i), b: pos(j), distance: d, angle, ligandAtom: names[i] ?? "", residue: resLabel(ri[j]!), residueAtom: names[j] ?? "" });
    }
  }

  // Salt bridges
  const ligCharges: { sign: 1 | -1; at: V; label: string }[] = [];
  for (const i of lig) {
    const hn = heavyNeighbours(i);
    const terminalO = hn.filter((j) => el(j) === O && heavyNeighbours(j).length === 1);
    if (el(i) === C && terminalO.length === 2) ligCharges.push({ sign: -1, at: centroid(terminalO.map(pos)), label: `${names[i] ?? "C"} carboxylate` });
    if ((el(i) === PHOS || el(i) === S) && hn.filter((j) => el(j) === O).length >= 3) ligCharges.push({ sign: -1, at: pos(i), label: `${names[i] ?? ""} ${el(i) === PHOS ? "phosphate" : "sulfate"}` });
    if (el(i) === C && hn.filter((j) => el(j) === N).length >= 2 && hn.length === 3 && hn.every((j) => el(j) === N || el(j) === C)) {
      ligCharges.push({ sign: 1, at: pos(i), label: `${names[i] ?? "C"} amidine/guanidine` });
    }
    // Amine: N bonded only to sp3-like carbons (none bonded to O, not in a guanidine)
    if (el(i) === N && hn.length >= 1 && hn.length <= 3 && hn.every((c) => el(c) === C && !heavyNeighbours(c).some((x) => el(x) === O) && heavyNeighbours(c).filter((x) => el(x) === N).length === 1)) {
      ligCharges.push({ sign: 1, at: pos(i), label: `${names[i] ?? "N"} amine` });
    }
  }
  const protCharges = new Map<number, { sign: 1 | -1; ps: V[]; names: string[] }>();
  for (const j of near) {
    const r = ri[j]!, def = PROTEIN_CHARGES[residues[r]?.name ?? ""];
    if (!def || !def.atoms.includes(names[j] ?? "")) continue;
    const g = protCharges.get(r) ?? { sign: def.sign, ps: [], names: [] };
    g.ps.push(pos(j)); g.names.push(names[j] ?? "");
    protCharges.set(r, g);
  }
  for (const lc of ligCharges) {
    for (const [r, g] of protCharges) {
      if (g.sign === lc.sign) continue;
      const c = centroid(g.ps), d = dist(lc.at, c);
      if (d <= 5.5) out.push({ type: "salt", a: lc.at, b: c, distance: d, ligandAtom: lc.label, residue: resLabel(r), residueAtom: g.names.join("/") });
    }
  }

  // π-stacking
  const ligRings: { ps: V[]; label: string }[] = [];
  {
    const inLig = new Set(lig), seen = new Set<string>();
    const ligNb = (i: number) => heavyNeighbours(i).filter((j) => inLig.has(j) && !METALS.has(el(j)));
    // Simple cycles of 5 or 6 atoms, each found once
    for (const start of lig) {
      const walk = (path: number[]) => {
        const last = path[path.length - 1]!;
        for (const n of ligNb(last)) {
          if (n === start && path.length >= 5) {
            const k = [...path].sort((x, y) => x - y).join(",");
            if (!seen.has(k)) { seen.add(k); ligRings.push({ ps: path.map(pos), label: path.map((x) => names[x] ?? "").join("-") }); }
          } else if (path.length < 6 && n > start && !path.includes(n)) walk([...path, n]);
        }
      };
      walk([start]);
    }
  }
  const flatLigRings = ligRings.filter((r) => ringPlane(r.ps).flat <= 0.25);
  const protRings: { ps: V[]; residue: string }[] = [];
  const byResidue = new Map<number, Map<string, number>>();
  for (const j of near) {
    const r = ri[j]!;
    if (!PROTEIN_RINGS[residues[r]?.name ?? ""]) continue;
    (byResidue.get(r) ?? byResidue.set(r, new Map()).get(r)!).set(names[j] ?? "", j);
  }
  for (const [r, atoms] of byResidue) {
    for (const ring of PROTEIN_RINGS[residues[r]!.name]!) {
      const idx = ring.map((n) => atoms.get(n));
      if (idx.every((x) => x !== undefined)) protRings.push({ ps: idx.map((x) => pos(x!)), residue: resLabel(r) });
    }
  }
  for (const lr of flatLigRings) {
    const lc = centroid(lr.ps), ln = ringPlane(lr.ps).normal;
    for (const pr of protRings) {
      const pc = centroid(pr.ps), pn = ringPlane(pr.ps).normal, d = dist(lc, pc);
      if (d > 5.5) continue;
      let a = angleDeg(ln, pn);
      if (a > 90) a = 180 - a;
      // Offset: the other centroid's distance from each ring's axis (the smaller one)
      const v = sub(pc, lc);
      const off = Math.min(Math.sqrt(Math.max(0, d * d - dot(v, ln) ** 2)), Math.sqrt(Math.max(0, d * d - dot(v, pn) ** 2)));
      const kind = a <= 30 ? "parallel" : a >= 60 ? "T-shaped" : null;
      if (kind && off <= 2.0) out.push({ type: "pi", a: lc, b: pc, distance: d, angle: a, ligandAtom: `ring ${lr.label}`, residue: pr.residue, residueAtom: "ring", detail: kind });
    }
  }

  // Hydrophobic contacts: closest carbon pair per residue
  const apolar = (i: number) => el(i) === C && heavyNeighbours(i).every((j) => el(j) === C);
  const closest = new Map<number, Interaction>();
  for (const i of lig) {
    if (!apolar(i)) continue;
    for (const j of near) {
      if (!apolar(j)) continue;
      const d = dist(pos(i), pos(j));
      if (d > 4.0 || d < 2.4 || bonded(i, j)) continue;
      const r = ri[j]!, cur = closest.get(r);
      if (!cur || d < cur.distance) closest.set(r, { type: "hydrophobic", a: pos(i), b: pos(j), distance: d, ligandAtom: names[i] ?? "", residue: resLabel(r), residueAtom: names[j] ?? "" });
    }
  }
  out.push(...closest.values());

  // Metal coordination
  for (const i of lig) {
    if (!METALS.has(el(i))) continue;
    for (const j of near) {
      if (el(j) !== N && el(j) !== O && el(j) !== S) continue;
      const d = dist(pos(i), pos(j));
      if (d <= 3.0) out.push({ type: "metal", a: pos(i), b: pos(j), distance: d, ligandAtom: names[i] ?? "", residue: resLabel(ri[j]!), residueAtom: names[j] ?? "" });
    }
  }

  const order: Record<InteractionType, number> = { metal: 0, salt: 1, hbond: 2, pi: 3, hydrophobic: 4 };
  return out.sort((x, y) => order[x.type] - order[y.type] || x.distance - y.distance);
}
