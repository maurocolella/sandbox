/*
 Title: SwapLayer
 Description: A ligand swapped into a pocket, as ball-and-stick with teal carbons (distinct from the
 entry's own ligands, pockets, chain colours and elements), following the sphere radius scale.
*/
import { useEffect, useMemo } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { elementColorRGB, vdwRadius } from "pdb-parser";
import { buildBallAndStick, disposeGroup } from "../lib/ballAndStick";

export interface SwapMolecule {
  elements: string[];
  positions: Float32Array; // xyz, Å, already placed
  bonds: [number, number][];
}

const CARBON = new THREE.Color(0x14b8a6);
const BALL_OVER = 1.07, STICK_RADIUS = 0.12; // as the entry's ligands

export function SwapLayer({ molecule, radiusScale }: { molecule: SwapMolecule | null; radiusScale: number }) {
  const invalidate = useThree((s) => s.invalidate);
  const group = useMemo(() => {
    if (!molecule) return new THREE.Group();
    const { group } = buildBallAndStick({
      positions: molecule.positions, bonds: molecule.bonds, stickRadius: STICK_RADIUS,
      radius: (i) => vdwRadius(molecule.elements[i]!) * radiusScale * BALL_OVER,
      color: (i, out) => {
        const el = molecule.elements[i]!;
        if (el.toUpperCase() === "C") return out.copy(CARBON);
        const [r, g, b] = elementColorRGB(el);
        return out.setRGB(r / 255, g / 255, b / 255);
      },
    });
    group.traverse((o) => { o.raycast = () => {}; });
    return group;
  }, [molecule, radiusScale]);

  useEffect(() => {
    invalidate();
    return () => disposeGroup(group);
  }, [group, invalidate]);

  return <primitive object={group} />;
}
