/*
 Title: useRenderKeys
 Description: Produces stable React render keys derived from selection and overlay toggles
 to force remounting of scene primitives when visual configuration changes.
*/
import { useMemo } from "react";

export type Representation = "spheres" | "ribbon-tube" | "ribbon-flat";

export interface OverlaysState {
  atoms: boolean;
  bonds: boolean;
  backbone: boolean;
}

export function useRenderKeys(selectionKey: string, representation: Representation, overlays: OverlaysState) {
  const base = useMemo(() => {
    const a = overlays.atoms ? 1 : 0;
    const b = overlays.bonds ? 1 : 0;
    const bb = overlays.backbone ? 1 : 0;
    return `sel:${selectionKey}|rep:${representation}|a:${a}|b:${b}|bb:${bb}`;
  }, [selectionKey, representation, overlays.atoms, overlays.bonds, overlays.backbone]);

  const atoms = `${base}-atoms`;
  const bonds = `${base}-bonds`;
  const backbone = `${base}-backbone`;
  const ribbon = `${base}-ribbon`;

  return { base, atoms, bonds, backbone, ribbon };
}
