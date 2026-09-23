/*
 Title: InstancesLod
 Description: Renders a chunked instance set (atoms, bonds) and picks each chunk's level of detail before
 every frame. While the camera moves, everything is one level coarser; one extra frame after motion stops
 refines it.
*/
import { useEffect, useRef, type MutableRefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { updateLevels, type ChunkedInstances } from "../lib/chunked";

export interface InstancesLodProps {
  set: ChunkedInstances;
  /** Upper bound on this set's triangles per frame. */
  triangleBudget: number;
  isCameraMovingRef?: MutableRefObject<boolean>;
}

export function InstancesLod({ set, triangleBudget, isCameraMovingRef }: InstancesLodProps) {
  const camera = useThree((s) => s.camera);
  const height = useThree((s) => s.size.height);
  const invalidate = useThree((s) => s.invalidate);
  const refine = useRef<number | null>(null);

  useFrame(() => {
    const moving = isCameraMovingRef?.current ?? false;
    updateLevels(set, camera, height, triangleBudget, moving ? 1 : 0);
    if (moving) {
      if (refine.current !== null) clearTimeout(refine.current);
      refine.current = window.setTimeout(() => { refine.current = null; invalidate(); }, 200);
    }
  });

  useEffect(() => { invalidate(); }, [triangleBudget, invalidate]);
  useEffect(() => () => { if (refine.current !== null) clearTimeout(refine.current); }, []);

  return <primitive object={set.group} />;
}
