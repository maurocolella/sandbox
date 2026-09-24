/*
 Title: InstancesLod
 Description: Renders an instance set (atoms, bonds) and picks each instance's level of detail before every frame,
 from what the current view needs (never from camera motion, so drags don't pop).
*/
import { useFrame, useThree } from "@react-three/fiber";
import { updateLod, type LodInstances } from "../lib/instancedLod";

export interface InstancesLodProps {
  set: LodInstances;
}

export function InstancesLod({ set }: InstancesLodProps) {
  const camera = useThree((s) => s.camera);
  const height = useThree((s) => s.size.height);
  const invalidate = useThree((s) => s.invalidate);

  useFrame(() => {
    if (updateLod(set, camera, height)) invalidate();
  });

  return <primitive object={set.group} />;
}
