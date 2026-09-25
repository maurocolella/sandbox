/*
 Title: AtomRaycast
 Description: Pointer picking of atoms through the atom set's LOD hierarchy (nearest-first, exact spheres
 in the leaves along the ray), so it needs no structure of its own and stays fast for millions of atoms.
 Emits onHover/onOut with instanceId (the atom index), and pauses while the camera is moving.
*/
import { useEffect, useRef } from "react";
import { useThree, type ThreeEvent, invalidate } from "@react-three/fiber";
import { Raycaster, Vector2 } from "three";
import { raycastSpheres, type LodInstances } from "../lib/instancedLod";

export interface AtomRaycastProps {
  atoms?: LodInstances;
  isCameraMovingRef: React.MutableRefObject<boolean>;
  onHover: (e: ThreeEvent<PointerEvent>) => void;
  onOut: () => void;
}

export function AtomRaycast({ atoms, isCameraMovingRef, onHover, onOut }: AtomRaycastProps) {
  const { camera, gl } = useThree();
  const rayRef = useRef(new Raycaster());
  const lastPos = useRef(new Vector2(9999, 9999));
  const leftDown = useRef(false);
  const eps = 0.001;
  const lastInstanceId = useRef<number | null>(null);

  useEffect(() => {
    const el = gl.domElement;
    const out = () => {
      if (lastInstanceId.current !== null) {
        onOut();
        lastInstanceId.current = null;
        invalidate();
      }
      el.style.cursor = 'default';
    };
    const handleMove = (event: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      const y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      const pos = new Vector2(x, y);
      if (leftDown.current) return;
      if (event.buttons !== 0) return; // skip raycasts during any mouse button drag
      if (isCameraMovingRef.current) { out(); return; }
      if (pos.distanceTo(lastPos.current) < eps) return;
      lastPos.current.copy(pos);
      if (!atoms) { out(); return; }
      rayRef.current.setFromCamera(pos, camera);
      const hit = raycastSpheres(atoms, rayRef.current.ray.origin, rayRef.current.ray.direction);
      if (hit < 0) { out(); return; }
      if (lastInstanceId.current !== hit) {
        lastInstanceId.current = hit;
        const fakeEvt = {
          stopPropagation: () => { },
          instanceId: hit,
        } as unknown as ThreeEvent<PointerEvent>;
        onHover(fakeEvt);
        invalidate();
        el.style.cursor = 'pointer';
      }
    };
    const handleDown = () => { leftDown.current = true; };
    const handleUp = () => { leftDown.current = false; };
    const handleLeave = () => { onOut(); el.style.cursor = 'default'; };
    el.addEventListener("mousemove", handleMove);
    el.addEventListener("mousedown", handleDown);
    el.addEventListener("mouseup", handleUp);
    el.addEventListener("mouseleave", handleLeave);
    return () => {
      el.removeEventListener("mousemove", handleMove);
      el.removeEventListener("mousedown", handleDown);
      el.removeEventListener("mouseup", handleUp);
      el.removeEventListener("mouseleave", handleLeave);
    };
  }, [gl, camera, onHover, onOut, atoms, isCameraMovingRef]);

  return null;
}
