/*
 Title: InstancesLod
 Description: Renders a chunked instance set (atoms, bonds) and picks each chunk's level of detail before
 every frame, from what the current view needs (never from camera motion, so drags don't pop).
*/
import { useEffect } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { updateLevels, type ChunkedInstances } from "../lib/chunked";

export interface InstancesLodProps {
  set: ChunkedInstances;
  /** Upper bound on this set's triangles per frame (soft). */
  triangleBudget: number;
}

export function InstancesLod({ set, triangleBudget }: InstancesLodProps) {
  const camera = useThree((s) => s.camera);
  const height = useThree((s) => s.size.height);
  const invalidate = useThree((s) => s.invalidate);

  useFrame(() => {
    if (updateLevels(set, camera, height, triangleBudget)) invalidate(); // settle any remaining steps next frame
  });

  useEffect(() => { invalidate(); }, [triangleBudget, invalidate]);

  return <primitive object={set.group} />;
}
