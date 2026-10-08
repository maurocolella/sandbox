/*
 Title: InteractionLayer
 Description: Ligand-polymer interactions as dashed lines coloured by type, with distance labels on the
 specific ones (hydrophobic contacts stay unlabelled to limit clutter). Dashes are thin unlit cylinders
 (WebGL lines are always 1 px wide, too faint to read).
*/
import { useEffect, useMemo } from "react";
import { Html } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { Interaction, InteractionType } from "../lib/interactions";

const DASH = 0.25, GAP = 0.15, RADIUS = 0.07; // Å

export const INTERACTION_COLORS: Record<InteractionType, string> = {
  hbond: "#3b82f6", salt: "#f59e0b", pi: "#22c55e", hydrophobic: "#9ca3af", metal: "#a855f7",
};

const LABEL_STYLE: React.CSSProperties = {
  whiteSpace: "nowrap", padding: "0 4px", borderRadius: 3, font: "10px ui-monospace, SFMono-Regular, Menlo, monospace",
  color: "var(--ui-fg, #e4e4e7)", background: "var(--ui-bg, rgb(24 24 27 / 0.55))",
};

export function InteractionLayer({ interactions }: { interactions: Interaction[] | null }) {
  const invalidate = useThree((s) => s.invalidate);
  const group = useMemo(() => {
    const g = new THREE.Group();
    // Dashes per type: [from, to] pairs
    const byType = new Map<InteractionType, [THREE.Vector3, THREE.Vector3][]>();
    for (const it of interactions ?? []) {
      const a = new THREE.Vector3(...it.a), b = new THREE.Vector3(...it.b), dir = b.clone().sub(a);
      const length = dir.length();
      dir.normalize();
      const list = byType.get(it.type) ?? byType.set(it.type, []).get(it.type)!;
      for (let t = 0; t < length; t += DASH + GAP) {
        list.push([a.clone().addScaledVector(dir, t), a.clone().addScaledVector(dir, Math.min(length, t + DASH))]);
      }
    }
    const geometry = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true);
    const up = new THREE.Vector3(0, 1, 0), m = new THREE.Matrix4(), q = new THREE.Quaternion(), mid = new THREE.Vector3(), d = new THREE.Vector3(), s = new THREE.Vector3();
    for (const [type, dashes] of byType) {
      const mesh = new THREE.InstancedMesh(geometry, new THREE.MeshBasicMaterial({ color: INTERACTION_COLORS[type] }), dashes.length);
      dashes.forEach(([from, to], k) => {
        d.subVectors(to, from);
        const l = d.length();
        q.setFromUnitVectors(up, d.normalize());
        mesh.setMatrixAt(k, m.compose(mid.addVectors(from, to).multiplyScalar(0.5), q, s.set(RADIUS, l, RADIUS)));
      });
      mesh.raycast = () => {};
      g.add(mesh);
    }
    return g;
  }, [interactions]);

  useEffect(() => {
    invalidate();
    return () => {
      const meshes = group.children as THREE.InstancedMesh[];
      meshes[0]?.geometry.dispose(); // shared by all types
      for (const mesh of meshes) { (mesh.material as THREE.Material).dispose(); mesh.dispose(); }
    };
  }, [group, invalidate]);

  return (
    <>
      <primitive object={group} />
      {(interactions ?? []).filter((it) => it.type !== "hydrophobic").map((it, k) => (
        <Html key={k} position={[(it.a[0] + it.b[0]) / 2, (it.a[1] + it.b[1]) / 2, (it.a[2] + it.b[2]) / 2]} center zIndexRange={[4, 0]} style={{ pointerEvents: "none" }}>
          <div style={{ ...LABEL_STYLE, color: INTERACTION_COLORS[it.type] }}>{it.distance.toFixed(1)} Å</div>
        </Html>
      ))}
    </>
  );
}
