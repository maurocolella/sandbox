/*
 Title: InstancesLod
 Description: Renders an instance set (atoms, bonds) and picks each instance's level of detail before every frame,
 from what the current view needs (never from camera motion, so drags don't pop).
*/
import { useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { updateLod, type LodInstances } from "../lib/instancedLod";

export interface InstancesLodProps {
  set: LodInstances;
  /** Called once the set has been drawn (its data uploaded to the GPU). */
  onDrawn?: () => void;
}

export function InstancesLod({ set, onDrawn }: InstancesLodProps) {
  const camera = useThree((s) => s.camera);
  const height = useThree((s) => s.size.height);
  const invalidate = useThree((s) => s.invalidate);

  const reported = useRef<LodInstances | null>(null);

  useFrame(() => {
    if (updateLod(set, camera, height)) invalidate();
    // This frame draws the set; report it once the frame is out
    if (reported.current !== set) { reported.current = set; if (onDrawn) requestAnimationFrame(() => onDrawn()); }
  });

  return <primitive object={set.group} />;
}
