/*
 Title: InteractionLayer
 Description: Ligand-polymer interactions as dashed lines coloured by type, with distance labels on the
 specific ones (hydrophobic contacts stay unlabelled to limit clutter).
*/
import { useEffect, useMemo } from "react";
import { Html } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { Interaction, InteractionType } from "../lib/interactions";

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
    const byType = new Map<InteractionType, number[]>();
    for (const it of interactions ?? []) (byType.get(it.type) ?? byType.set(it.type, []).get(it.type)!).push(...it.a, ...it.b);
    for (const [type, coords] of byType) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(coords, 3));
      const lines = new THREE.LineSegments(geometry, new THREE.LineDashedMaterial({ color: INTERACTION_COLORS[type], dashSize: 0.25, gapSize: 0.18 }));
      lines.computeLineDistances();
      lines.raycast = () => {};
      g.add(lines);
    }
    return g;
  }, [interactions]);

  useEffect(() => {
    invalidate();
    return () => group.traverse((o) => {
      if (o instanceof THREE.LineSegments) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); }
    });
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
