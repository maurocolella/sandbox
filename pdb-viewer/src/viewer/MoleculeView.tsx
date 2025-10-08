import { Suspense, useEffect, useMemo, useState, useRef } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, AdaptiveDpr, Preload } from "@react-three/drei";
import { Leva, useControls } from "leva";
import type { InstancedMesh as InstancedMeshType, LineSegments, Material } from "three";
import { useMolScene } from "./useMolScene";
import { makeAtomsMesh, makeBondLines, makeBackboneLines, makeRibbonMesh, makeFlatRibbonMesh } from "pdb-parser";
import type { ParseOptions, MolScene, AtomMeshOptions, BackboneLineOptions } from "pdb-parser";
import { Vector3, Mesh } from "three";

type SceneBuildOptions = {
  atoms: AtomMeshOptions | false;
  bonds: boolean;
  backbone: BackboneLineOptions | false;
};

function useSceneObjects(scene: MolScene | null, opts: SceneBuildOptions) {
  const objects = useMemo(() => {
    if (!scene) return { atoms: undefined as InstancedMeshType | undefined, bonds: undefined as LineSegments | undefined, backbone: undefined as LineSegments | undefined };

    let atoms: InstancedMeshType | undefined;
    let bonds: LineSegments | undefined;
    let backbone: LineSegments | undefined;

    if (opts.atoms !== false) {
      atoms = makeAtomsMesh(scene, {
        sphereDetail: opts.atoms?.sphereDetail ?? 16,
        materialKind: (opts.atoms?.materialKind ?? "standard") as AtomMeshOptions["materialKind"],
        radiusScale: opts.atoms?.radiusScale ?? 1.0,
      });
      // Force uniform white material (disable vertex colors), mirroring the earlier fuchsia override but with white.
      if (atoms) {
        const mat = atoms.material as unknown as { vertexColors?: boolean; color?: { set: (v: string) => void }; needsUpdate?: boolean };
        if (typeof mat.vertexColors !== "undefined") mat.vertexColors = false;
        if (mat.color) mat.color.set("#ffffff");
        if (typeof mat.needsUpdate !== "undefined") mat.needsUpdate = true;
      }
    }
    if (opts.bonds) {
      bonds = makeBondLines(scene) as LineSegments | undefined;
    }
    if (opts.backbone !== false) {
      backbone = makeBackboneLines(scene, { color: opts.backbone?.color ?? 0xffffff }) as LineSegments | undefined;
    }

    return { atoms, bonds, backbone };
  }, [scene, opts.atoms, opts.bonds, opts.backbone]);

  // dispose on change/unmount
  useEffect(() => {
    return () => {
      objects.atoms?.geometry.dispose();
      (objects.atoms?.material as Material | undefined)?.dispose?.();
      objects.bonds?.geometry.dispose();
      (objects.bonds?.material as Material | undefined)?.dispose?.();
      objects.backbone?.geometry.dispose();
      (objects.backbone?.material as Material | undefined)?.dispose?.();
    };
  }, [objects.atoms, objects.bonds, objects.backbone]);

  return objects;
}

export function MoleculeView() {
  // Controls: parsing + rendering
  const [sourceUrl, setSourceUrl] = useState<string>("/models/1IGY.pdb");

  const parseOpts = useControls("Parse", {
    altLocPolicy: { value: "occupancy", options: ["occupancy", "all"] as ParseOptions["altLocPolicy"][] },
    modelSelection: { value: 1, min: 1, step: 1 },
    bondPolicy: { value: "conect+heuristic", options: ["conect-only", "heuristic-if-missing", "conect+heuristic"] as ParseOptions["bondPolicy"][] },
  });

  // Common controls
  const common = useControls("Common", {
    representation: { value: "spheres", options: ["spheres", "ribbon-tube", "ribbon-flat"] as const },
    materialKind: { value: "standard", options: ["basic", "lambert", "standard"] as const },
    background: { value: "#111111" },
  });

  // Overlays (apply across modes)
  const overlays = useControls("Overlays", {
    atoms: {
      value: true,
      render: (get) => get("Common.representation") === "spheres",
    },
    bonds: true,
    backbone: {
      value: true,
      render: (get) => get("Common.representation") === "spheres",
    },
  });

  // Spheres-only controls
  const spheres = useControls("Spheres", {
    sphereDetail: {
      value: 16, min: 4, max: 32, step: 2,
      render: (get) => get("Common.representation") === "spheres",
    },
    radiusScale: {
      value: 0.3, min: 0.05, max: 2.0, step: 0.05,
      render: (get) => get("Common.representation") === "spheres",
    },
  });

  // Ribbon-only controls
  const ribbon = useControls("Ribbon", {
    thickness: {
      value: 0.18, min: 0.02, max: 0.6, step: 0.01,
      render: (get) => get("Common.representation") === "ribbon-flat",
    },
  });

  const { scene, error, loading } = useMolScene(sourceUrl, parseOpts as ParseOptions);
  const objects = useSceneObjects(scene, {
    atoms: overlays.atoms && common.representation === "spheres"
      ? { sphereDetail: spheres.sphereDetail, materialKind: common.materialKind as AtomMeshOptions["materialKind"], radiusScale: spheres.radiusScale }
      : false,
    bonds: overlays.bonds,
    backbone: overlays.backbone && common.representation === "spheres" ? {} : false,
  });

  // Build ribbon group only when selected
  const ribbonGroup = useMemo(() => {
    if (!scene) return null;
    if (common.representation === "ribbon-tube") {
      return makeRibbonMesh(scene, {
        radius: 0.4,
        radialSegments: 12,
        tubularSegmentsPerPoint: 6,
        materialKind: common.materialKind as AtomMeshOptions["materialKind"],
        color: 0xffffff,
      });
    }
    if (common.representation === "ribbon-flat") {
      return makeFlatRibbonMesh(scene, {
        width: 1.2,
        segmentsPerPoint: 6,
        materialKind: common.materialKind as AtomMeshOptions["materialKind"],
        color: 0xffffff,
        doubleSided: true,
        thickness: ribbon.thickness,
      });
    }
    return null;
  }, [scene, common.representation, common.materialKind, ribbon.thickness]);

  // Dispose ribbon on change/unmount
  useEffect(() => {
    return () => {
      if (!ribbonGroup) return;
      ribbonGroup.traverse((obj) => {
        if (obj instanceof Mesh) {
          // geometry is BufferGeometry on Mesh
          obj.geometry.dispose();
          const m = obj.material;
          if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
          else m.dispose();
        }
      });
    };
  }, [ribbonGroup]);

  useEffect(() => {
    document.body.style.background = common.background;
  }, [common.background]);
  
  // OrbitControls ref (minimal shape we need)
  type ControlsRef = {
    target: Vector3;
    object: { position: Vector3; fov?: number; updateProjectionMatrix?: () => void };
    update: () => void;
  };
  const controlsRef = useRef<ControlsRef | null>(null);

  // On new scene load: center and frame the model (compute distance from bbox/atoms)
  const lastSceneRef = useRef<MolScene | null>(null);
  useEffect(() => {
    if (!scene || loading) return;
    if (lastSceneRef.current === scene) return;
    if (!controlsRef.current) {
      lastSceneRef.current = scene;
      return;
    }
    // Compute center/size from bbox if present, else from atom positions
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    if (scene.bbox) {
      [minX, minY, minZ] = scene.bbox.min;
      [maxX, maxY, maxZ] = scene.bbox.max;
    } else {
      const a = scene.atoms;
      if (a && a.count > 0) {
        const p = a.positions;
        for (let i = 0; i < a.count; i++) {
          const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
          if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
          if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
        }
      }
    }
    if (!Number.isFinite(minX) || !Number.isFinite(maxX)) {
      lastSceneRef.current = scene;
      return;
    }
    const c = new Vector3((minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5);
    const sizeX = Math.max(1e-6, maxX - minX);
    const sizeY = Math.max(1e-6, maxY - minY);
    // Frame using camera FOV and viewport aspect
    const ctrl = controlsRef.current;
    const cam = ctrl.object;
    const vFov = (cam.fov ?? 60) * Math.PI / 180;
    const aspect = (typeof window !== "undefined" && window.innerHeight > 0)
      ? (window.innerWidth / window.innerHeight)
      : 1.6;
    const halfW = sizeX * 0.5;
    const halfH = sizeY * 0.5;
    const distY = halfH / Math.tan(vFov / 2);
    const distX = halfW / (Math.tan(vFov / 2) * aspect);
    const margin = 1.6; // gentle padding
    const desiredDist = Math.max(distX, distY) * margin;

    ctrl.target.copy(c);
    const dir = cam.position.clone().sub(ctrl.target).normalize();
    if (!Number.isFinite(dir.x) || !Number.isFinite(dir.y) || !Number.isFinite(dir.z) || dir.lengthSq() < 1e-6) {
      dir.set(0, 0, 1);
    }
    cam.position.copy(c.clone().add(dir.multiplyScalar(desiredDist)));
    cam.updateProjectionMatrix?.();
    ctrl.update();
    lastSceneRef.current = scene;
  }, [scene, loading]);

  return (
    <div style={{ display: 'flex', height: '100%', flex: 1 }}>
      <Leva collapsed={false} oneLineLabels hideCopyButton />
      <div style={{ position: "absolute", top: 10, left: 10, zIndex: 1 }}>
        <input
          type="text"
          value={sourceUrl}
          onChange={(e) => setSourceUrl(e.target.value)}
          placeholder="/models/1IGY.pdb or URL"
          style={{ width: 320, padding: 10, background: "#222", color: "#eee", border: "1px solid #444", borderRadius: 4 }}
        />
      </div>
      <Canvas
        gl={{ antialias: true }}
        dpr={[1, Math.min(window.devicePixelRatio || 1, 2)]}
        camera={{ position: [0, 0, 100], near: 0.1, far: 5000 }}
      >
        <color attach="background" args={[common.background]} />
        <ambientLight intensity={1.0} />
        <directionalLight position={[5, 10, 5]} intensity={1.0} />
        <OrbitControls
          ref={(ctrl) => {
            // ctrl is OrbitControls from drei; store minimal fields we use
            if (ctrl) controlsRef.current = ctrl as unknown as ControlsRef;
          }}
          enableDamping
          dampingFactor={0.1}
          makeDefault
        />
        <AdaptiveDpr pixelated />
        <Preload all />
        <Suspense fallback={null}>
          {common.representation !== "spheres" && ribbonGroup && (
            <>
              <primitive object={ribbonGroup} />
              {overlays.bonds && objects.bonds && <primitive object={objects.bonds} />}
              {overlays.backbone && objects.backbone && <primitive object={objects.backbone} />}
            </>
          )}
          {common.representation === "spheres" && (
            <>
              {objects.atoms && <primitive object={objects.atoms} />}
              {objects.bonds && <primitive object={objects.bonds} />}
              {objects.backbone && <primitive object={objects.backbone} />}
            </>
          )}
        </Suspense>
      </Canvas>
      {loading && (
        <div style={{ position: "absolute", left: 12, bottom: 12, color: "#ccc", fontFamily: "monospace", fontSize: 12 }}>
          Loading…
        </div>
      )}
      {error && (
        <div style={{ position: "absolute", left: 12, bottom: 12, color: "#f88", fontFamily: "monospace", fontSize: 12 }}>
          {error}
        </div>
      )}
    </div>
  );
}
