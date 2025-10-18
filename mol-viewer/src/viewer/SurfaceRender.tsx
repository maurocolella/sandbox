import { useEffect, useMemo, useState } from "react";
import type { MolScene } from "pdb-parser";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, AdaptiveDpr, Preload } from "@react-three/drei";
import * as THREE from "three";
import type { Atom } from "chem-surface";
import { generateVDW, generateSAS, generateSES } from "chem-surface";

interface SurfaceRenderProps {
  background: string;
  scene: MolScene | null;
  kind: "vdw" | "sas" | "ses";
  probeRadius: number;
  voxelSize: number;
}

function atomsFromScene(scene: MolScene | null): Atom[] {
  if (!scene?.atoms?.positions || !scene?.atoms?.radii || !scene?.atoms?.count) return [];
  const n = scene.atoms.count;
  const out: Atom[] = new Array(n);
  const pos = scene.atoms.positions as Float32Array;
  const rad = scene.atoms.radii as Float32Array;
  for (let i = 0; i < n; i++) {
    const j = i * 3;
    out[i] = { x: pos[j], y: pos[j + 1], z: pos[j + 2], radius: rad[i] };
  }
  return out;
}

export function SurfaceRender(props: SurfaceRenderProps) {
  const atoms = useMemo(() => atomsFromScene(props.scene), [props.scene]);
  const [geometry, setGeometry] = useState<THREE.BufferGeometry | null>(null);

  useEffect(() => {
    let aborted = false;
    async function run() {
      if (atoms.length === 0) { setGeometry(null); return; }
      const opts = { probeRadius: props.probeRadius, voxelSize: props.voxelSize };
      const geom = props.kind === "vdw"
        ? await generateVDW(atoms, opts)
        : props.kind === "sas"
          ? await generateSAS(atoms, opts)
          : await generateSES(atoms, opts);
      if (aborted) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(geom.positions, 3));
      g.setAttribute("normal", new THREE.BufferAttribute(geom.normals, 3));
      if (geom.indices) g.setIndex(new THREE.BufferAttribute(geom.indices, 1));
      setGeometry(g);
    }
    void run();
    return () => { aborted = true; };
  }, [atoms, props.kind, props.probeRadius, props.voxelSize]);

  const material = useMemo(() => new THREE.MeshStandardMaterial({ color: 0x77aaff, metalness: 0.0, roughness: 1.0 }), []);

  return (
    <Canvas
      frameloop="demand"
      gl={{ antialias: true, powerPreference: 'high-performance' }}
      dpr={[1, Math.min(window.devicePixelRatio || 1, 2)]}
      camera={{ position: [0, 0, 100], near: 0.1, far: 5000 }}
    >
      <color attach="background" args={[props.background]} />
      <ambientLight intensity={1.0} />
      <directionalLight position={[5, 10, 5]} intensity={1.0} />
      <OrbitControls enableDamping dampingFactor={0.1} makeDefault />
      <AdaptiveDpr pixelated />
      <Preload all />
      {geometry && (
        <mesh geometry={geometry} material={material} />
      )}
    </Canvas>
  );
}
