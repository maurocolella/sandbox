/*
 Title: useHoverState
 Description: Encapsulates hover interaction state for the viewer. Maps instanced
 atom IDs from picking to atom/residue/chain indices based on the selected mode,
 and exposes onHover/onOut handlers without shader patching.
*/
import { useCallback, useState } from "react";
import type { MolScene } from "pdb-parser";

export type HoverMode = "atom" | "residue" | "chain";

export interface RayHoverEvent {
  instanceId?: number;
}

export interface HoverState {
  hoveredAtom: number;
  hoveredResidue: number;
  hoveredChain: number;
  onHover: (e: RayHoverEvent) => void;
  onOut: () => void;
}

export function useHoverState(scene: MolScene | null, mode: HoverMode): HoverState {
  const [hoveredAtom, setHoveredAtom] = useState<number>(-1);
  const [hoveredResidue, setHoveredResidue] = useState<number>(-1);
  const [hoveredChain, setHoveredChain] = useState<number>(-1);

  const onHover = useCallback((e: RayHoverEvent) => {
    const id = e.instanceId;
    if (id == null) return;
    if (mode === "atom") {
      setHoveredAtom((prev) => (prev === id ? prev : id));
      if (hoveredResidue !== -1) setHoveredResidue(-1);
      if (hoveredChain !== -1) setHoveredChain(-1);
      return;
    }
    if (mode === "residue") {
      const ri = scene?.atoms?.residueIndex as (number[] | Uint32Array | undefined);
      const idx = ri ? (ri[id] as number) : -1;
      setHoveredResidue((prev) => (prev === idx ? prev : (idx ?? -1)));
      if (hoveredAtom !== -1) setHoveredAtom(-1);
      if (hoveredChain !== -1) setHoveredChain(-1);
      return;
    }
    // chain
    const ci = scene?.atoms?.chainIndex as (number[] | Uint32Array | undefined);
    const cidx = ci ? (ci[id] as number) : -1;
    setHoveredChain((prev) => (prev === cidx ? prev : (cidx ?? -1)));
    if (hoveredAtom !== -1) setHoveredAtom(-1);
    if (hoveredResidue !== -1) setHoveredResidue(-1);
  }, [scene, mode, hoveredAtom, hoveredResidue, hoveredChain]);

  const onOut = useCallback(() => {
    if (hoveredAtom !== -1) setHoveredAtom(-1);
    if (hoveredResidue !== -1) setHoveredResidue(-1);
    if (hoveredChain !== -1) setHoveredChain(-1);
  }, [hoveredAtom, hoveredResidue, hoveredChain]);

  return { hoveredAtom, hoveredResidue, hoveredChain, onHover, onOut };
}
