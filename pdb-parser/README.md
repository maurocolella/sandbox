# pdb-parser

Lean PDB parser that returns a renderer-agnostic `MolScene` for web visualization. Clean, modular TypeScript with minimal dependencies. Three.js adapters are optional and kept separate for clarity.

## Install

```sh
pnpm add pdb-parser three
```

Three.js is a peer dependency. You supply it in your app; this library stays renderer-agnostic.

## Quick start

```ts
import { parsePdbToMolScene, makeSceneObjects } from "pdb-parser";

const scene = parsePdbToMolScene(pdbText, {
  altLocPolicy: "occupancy",          // or "all"
  modelSelection: 1,                   // default 1
  bondPolicy: "heuristic-if-missing", // or "conect-only" | "conect+heuristic"
});

const { atoms, bonds, backbone } = makeSceneObjects(scene, {
  atoms: { sphereDetail: 16 },
  bonds: {},
  backbone: {},
});

// Three.js: add to your scene
threeScene.add(atoms);
if (bonds) threeScene.add(bonds);
if (backbone) threeScene.add(backbone);
```

React Three Fiber works directly with these objects via `<primitive object={...} />`.

## API (selected)

- `parsePdbToMolScene(pdbText, options?) => MolScene`
  - Returns typed arrays for atoms, optional bonds, backbone, tables (chains/residues/segments), bbox, metadata.
- Modular Three adapters (no magic):
  - `makeAtomsMesh(scene, { sphereDetail?, materialKind? }) => THREE.InstancedMesh`
  - `makeBondLines(scene) => THREE.LineSegments | undefined`
  - `makeBackboneLines(scene, { color? }) => THREE.LineSegments | undefined`
  - `makeSceneObjects(scene, { atoms?, bonds?, backbone? }) => { atoms?, bonds?, backbone? }`
- Selection helpers:
  - `getAtomSelection(scene, instanceId)` → chain/residue/atom metadata
  - `getBondSelection(scene, segmentIndex)` → metadata for a bond line segment
  - `formatAtomLabel(selection)` → human-friendly label

### Parser options

- `altLocPolicy`: `"occupancy"` (default) or `"all"`
- `modelSelection`: number (1-based; default 1)
- `bondPolicy`: `"conect-only"` (default), `"heuristic-if-missing"`, `"conect+heuristic"`

Backbone polyline is built from Cα/P atoms and segmented by `TER` (with per-chain fallback if `TER` is absent).

## License

Apache 2.0. See `LICENSE.md`.
