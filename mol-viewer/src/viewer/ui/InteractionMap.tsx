/*
 Title: InteractionMap
 Description: LigPlot-style 2D interaction map: the ligand's 2D structure (Kekulé bonds, heteroatom labels
 with their hydrogens) and, around it, each interacting residue, joined by dashed lines coloured by
 interaction type from the ligand atoms involved (distances on all but hydrophobic contacts). Residues sit on
 a ring around the ligand, each at the angle of its contacts, spread so labels don't overlap.
*/
import { useEffect, useMemo, useState } from "react";
import type { MolScene } from "pdb-parser";
import { INTERACTION_COLORS, type Interaction, type InteractionType, type LigandRef } from "mol-renderer";
import { depictLigand, type Depiction } from "../../lib/depict";

const S = 26; // px per depiction unit (RDKit bonds are 1.5 units)
const FONT = 11;
const LABEL_SHRINK = 0.32; // units a bond stops short of a labelled atom
const RING_GAP = 2.4; // units between the ligand's extent and the residue ring
const PRIORITY: InteractionType[] = ["salt", "metal", "hbond", "pi", "hydrophobic"];
const ELEMENT_COLORS: Record<string, string> = {
  N: "#3d6fe0", O: "#e0453a", S: "#c9a227", P: "#e08a2e", F: "#3aa65a", CL: "#3aa65a", BR: "#a0522d", I: "#7b3fa0", FE: "#c06030",
};

type Pt = { x: number; y: number };
const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();
/** "ASP A 113" -> "Asp113" */
const residueLabel = (r: string) => { const [name, , seq] = r.split(" "); return `${titleCase(name ?? r)}${seq ?? ""}`; };

function atomLabel(a: Depiction["atoms"][number]) {
  if (a.el === "C" && a.charge === 0) return null;
  const h = a.hs > 0 ? (a.hs > 1 ? `H${a.hs}` : "H") : "";
  const charge = a.charge === 0 ? "" : `${Math.abs(a.charge) > 1 ? Math.abs(a.charge) : ""}${a.charge > 0 ? "+" : "−"}`;
  return { text: `${a.el.length > 1 ? titleCase(a.el) : a.el}${h}`, charge };
}

interface Layout {
  width: number; height: number;
  bonds: { x1: number; y1: number; x2: number; y2: number }[];
  labels: { x: number; y: number; text: string; charge: string; color: string }[];
  nodes: { x: number; y: number; w: number; text: string; color: string }[];
  links: { x1: number; y1: number; x2: number; y2: number; color: string; text?: string; tx: number; ty: number }[];
}

function layout(dep: Depiction, scene: MolScene, interactions: Interaction[]): Layout {
  const P = scene.atoms.positions;
  const pts: Pt[] = dep.atoms.map((a) => ({ x: a.x * S, y: a.y * S }));
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length, cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const labelled = dep.atoms.map((a) => atomLabel(a) !== null);
  const nbrs: number[][] = dep.atoms.map(() => []);
  for (const b of dep.bonds) { nbrs[b.a]!.push(b.b); nbrs[b.b]!.push(b.a); }

  // Bonds: shortened at labelled atoms; a double bond's second line toward the side of its neighbours (rings)
  // or, at a terminal double bond, both lines either side
  const bonds: Layout["bonds"] = [];
  for (const { a, b, order } of dep.bonds) {
    const p = pts[a]!, q = pts[b]!;
    const dx = q.x - p.x, dy = q.y - p.y, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
    const s0 = labelled[a] ? LABEL_SHRINK * S : 0, s1 = labelled[b] ? LABEL_SHRINK * S : 0;
    const x1 = p.x + ux * s0, y1 = p.y + uy * s0, x2 = q.x - ux * s1, y2 = q.y - uy * s1;
    const nx = -uy, ny = ux, off = 0.18 * S;
    const line = (o: number, trim = 0) => bonds.push({ x1: x1 + nx * o + ux * trim, y1: y1 + ny * o + uy * trim, x2: x2 + nx * o - ux * trim, y2: y2 + ny * o - uy * trim });
    if (order === 2) {
      let side = 0;
      for (const n of [...nbrs[a]!.filter((x) => x !== b), ...nbrs[b]!.filter((x) => x !== a)]) side += Math.sign((pts[n]!.x - p.x) * ny - (pts[n]!.y - p.y) * -nx);
      if (side === 0) { line(off / 2); line(-off / 2); } else { line(0); line(Math.sign(side) * off, 0.12 * len); }
    } else if (order === 3) { line(0); line(off); line(-off); } else line(0);
  }
  const labels: Layout["labels"] = dep.atoms.flatMap((a, k) => {
    const l = atomLabel(a);
    return l ? [{ x: pts[k]!.x, y: pts[k]!.y, text: l.text, charge: l.charge, color: ELEMENT_COLORS[a.el.toUpperCase()] ?? "var(--ui-fg)" }] : [];
  });

  // Each interaction's 2D anchor: the drawn atoms near its ligand-side point (a ring or group centre averages them)
  const anchorOf = (pt: [number, number, number]): Pt => {
    let near: number[] = [], best = 0, bestD = Infinity;
    dep.atoms.forEach((a, k) => {
      const d = Math.hypot(P[a.scene * 3]! - pt[0], P[a.scene * 3 + 1]! - pt[1], P[a.scene * 3 + 2]! - pt[2]);
      if (d < 1.6) near.push(k);
      if (d < bestD) { bestD = d; best = k; }
    });
    if (bestD < 0.3) near = [best]; // the atom itself
    if (near.length === 0) near = [best];
    return { x: near.reduce((s, k) => s + pts[k]!.x, 0) / near.length, y: near.reduce((s, k) => s + pts[k]!.y, 0) / near.length };
  };
  const byResidue = new Map<string, { anchors: Pt[]; items: { it: Interaction; at: Pt }[] }>();
  for (const it of interactions) {
    const g = byResidue.get(it.residue) ?? { anchors: [], items: [] };
    const at = anchorOf(it.a);
    g.anchors.push(at); g.items.push({ it, at });
    byResidue.set(it.residue, g);
  }

  // Residues on a ring around the ligand, at their contacts' angle, relaxed apart until labels clear
  const extent = Math.max(...pts.map((p) => Math.hypot(p.x - cx, p.y - cy))) + RING_GAP * S;
  const groups = [...byResidue].map(([residue, g]) => {
    const ax = g.anchors.reduce((s, p) => s + p.x, 0) / g.anchors.length, ay = g.anchors.reduce((s, p) => s + p.y, 0) / g.anchors.length;
    const type = PRIORITY.find((t) => g.items.some((i) => i.it.type === t))!;
    const text = residueLabel(residue);
    return { g, text, w: text.length * FONT * 0.62 + 10, theta: Math.atan2(ay - cy, ax - cx), type };
  }).sort((a, b) => a.theta - b.theta);
  let radius = extent;
  const need = groups.reduce((s, g) => s + g.w + 8, 0);
  radius = Math.max(radius, need / (2 * Math.PI));
  for (let iter = 0; iter < 200 && groups.length > 1; iter++) {
    let moved = false;
    for (let k = 0; k < groups.length; k++) {
      const g = groups[k]!, h = groups[(k + 1) % groups.length]!;
      const gap = ((g.w + h.w) / 2 + 8) / radius;
      let d = h.theta - g.theta;
      if (k === groups.length - 1) d += 2 * Math.PI;
      if (d < gap) { const push = (gap - d) / 2; g.theta -= push; h.theta += push; moved = true; }
    }
    if (!moved) break;
  }
  const nodes: Layout["nodes"] = [], links: Layout["links"] = [];
  for (const g of groups) {
    const x = cx + Math.cos(g.theta) * radius, y = cy + Math.sin(g.theta) * radius * 0.85;
    nodes.push({ x, y, w: g.w, text: g.text, color: INTERACTION_COLORS[g.type] });
    for (const { it, at } of g.g.items) {
      // Ends at the residue box; the distance sits beside the line
      const dx = x - at.x, dy = y - at.y, len = Math.hypot(dx, dy) || 1;
      const t = Math.min(g.w / 2 / (Math.abs(dx) || 1e-6), 9 / (Math.abs(dy) || 1e-6), 1); // fraction of the way back to the anchor
      const x2 = x - dx * t, y2 = y - dy * t;
      const mx = at.x + dx * 0.45, my = at.y + dy * 0.45, side = 8;
      links.push({
        x1: at.x, y1: at.y, x2, y2, color: INTERACTION_COLORS[it.type],
        text: it.type === "hydrophobic" ? undefined : `${it.distance.toFixed(1)}`, tx: mx - (dy / len) * side, ty: my + (dx / len) * side,
      });
    }
  }

  // Fit everything into the view
  const xs = [...pts.map((p) => p.x), ...nodes.flatMap((n) => [n.x - n.w / 2, n.x + n.w / 2])];
  const ys = [...pts.map((p) => p.y), ...nodes.flatMap((n) => [n.y - 10, n.y + 10])];
  const minX = Math.min(...xs) - 12, minY = Math.min(...ys) - 12;
  const shift = <T extends Record<string, unknown>>(o: T, keys: [string, string][]) => { for (const [kx, ky] of keys) { (o as Record<string, number>)[kx] -= minX; (o as Record<string, number>)[ky] -= minY; } return o; };
  return {
    width: Math.max(...xs) + 12 - minX, height: Math.max(...ys) + 12 - minY,
    bonds: bonds.map((b) => shift(b, [["x1", "y1"], ["x2", "y2"]])),
    labels: labels.map((l) => shift(l, [["x", "y"]])),
    nodes: nodes.map((n) => shift(n, [["x", "y"]])),
    links: links.map((l) => shift(l, [["x1", "y1"], ["x2", "y2"], ["tx", "ty"]])),
  };
}

export function InteractionMap({ scene, ligand, interactions }: { scene: MolScene; ligand: LigandRef; interactions: Interaction[] }) {
  const [dep, setDep] = useState<{ value?: Depiction | null; error?: string }>({});
  useEffect(() => {
    let live = true;
    setDep({});
    depictLigand(scene, ligand)
      .then((value) => { if (live) setDep({ value }); })
      .catch((e) => { if (live) setDep({ error: e instanceof Error ? e.message : String(e) }); });
    return () => { live = false; };
  }, [scene, ligand.compId, ligand.chain, ligand.seq]); // eslint-disable-line react-hooks/exhaustive-deps

  const view = useMemo(() => (dep.value ? layout(dep.value, scene, interactions) : null), [dep.value, scene, interactions]);
  if (dep.error) return <div className="text-red-400">2D drawing failed: {dep.error}</div>;
  if (dep.value === undefined) return <div className="text-(--ui-muted)">Drawing…</div>;
  if (!view) return <div className="text-(--ui-muted)">No 2D drawing for this ligand.</div>;

  return (
    <svg viewBox={`0 0 ${view.width} ${view.height}`} className="w-full" style={{ maxHeight: 360 }} role="img" aria-label="2D interaction map">
      <g strokeWidth={1.2} strokeDasharray="4 3" fill="none">
        {view.links.map((l, k) => <line key={k} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke={l.color} opacity={0.9} />)}
      </g>
      <g stroke="var(--ui-fg)" strokeWidth={1.4} strokeLinecap="round">
        {view.bonds.map((b, k) => <line key={k} x1={b.x1} y1={b.y1} x2={b.x2} y2={b.y2} />)}
      </g>
      <g fontSize={FONT} fontFamily="ui-sans-serif, system-ui, sans-serif" textAnchor="middle" dominantBaseline="central">
        {view.labels.map((l, k) => (
          <text key={k} x={l.x} y={l.y} fill={l.color} fontWeight={600}>
            {l.text}{l.charge && <tspan dy={-4} fontSize={FONT * 0.75}>{l.charge}</tspan>}
          </text>
        ))}
        {view.links.filter((l) => l.text).map((l, k) => (
          <text key={k} x={l.tx} y={l.ty} fill={l.color} fontSize={FONT - 2}>{l.text}</text>
        ))}
        {view.nodes.map((n, k) => (
          <g key={k}>
            <rect x={n.x - n.w / 2} y={n.y - 9} width={n.w} height={18} rx={9} fill="var(--ui-input)" stroke={n.color} strokeWidth={1.2} />
            <text x={n.x} y={n.y} fill="var(--ui-strong)" fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace">{n.text}</text>
          </g>
        ))}
      </g>
    </svg>
  );
}
