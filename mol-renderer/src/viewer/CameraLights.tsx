/*
 Title: CameraLights
 Description: Lighting rig that follows the camera, like PyMOL's: a soft hemisphere for form, a key light
 from the viewer's upper left and a weak fill from the lower right, so the side facing the viewer is always lit.
*/
import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import type { DirectionalLight, Group, Object3D } from "three";

export function CameraLights() {
  const camera = useThree((s) => s.camera);
  const rig = useRef<Group>(null);
  const key = useRef<DirectionalLight>(null);
  const fill = useRef<DirectionalLight>(null);
  const target = useRef<Object3D>(null);

  useEffect(() => {
    // Both lights aim along the view direction (target sits in front of the camera, inside the rig)
    if (target.current && key.current && fill.current) {
      key.current.target = target.current;
      fill.current.target = target.current;
    }
  }, []);

  useFrame(() => {
    if (!rig.current) return;
    rig.current.position.copy(camera.position);
    rig.current.quaternion.copy(camera.quaternion);
  });

  return (
    <>
      <hemisphereLight args={["#ffffff", "#2a2e36", 0.85]} />
      <group ref={rig}>
        <directionalLight ref={key} position={[-1.2, 1.4, 0.6]} intensity={1.9} />
        <directionalLight ref={fill} position={[1.4, -0.8, 0.4]} intensity={0.35} />
        <object3D ref={target} position={[0, 0, -1]} />
      </group>
    </>
  );
}
