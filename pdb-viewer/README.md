# pdb-viewer

React + TypeScript + Vite molecular viewer that consumes the sibling `pdb-parser` library and renders with Three.js via React Three Fiber.

It loads a PDB file, parses it to a renderer‑agnostic `MolScene`, and builds Three objects for atoms (instanced spheres), bonds (line segments), and a backbone polyline. The canvas fills the viewport and adapts DPR for performance.

## Features

- Three.js rendering with React Three Fiber (`@react-three/fiber`) and helpers from `@react-three/drei`.
- Full‑viewport canvas, `OrbitControls`, `AdaptiveDpr`, and auto‑framing via `Bounds`.
- Modular object creation through the parser’s adapters: `makeAtomsMesh`, `makeBondLines`, `makeBackboneLines`.
- Parsing controls (altLoc/model/bonds) and rendering controls (atoms/bonds/backbone toggles, sphere detail, radius scale, material kind, background) via Leva.
- Default model fixture: `public/models/1IGY.pdb`.

## Prerequisites

- Node.js 18+ and pnpm.
- This project expects the sibling library `../pdb-parser` to exist and be buildable. The dependency is linked locally via `"pdb-parser": "link:../pdb-parser"` in `package.json`.

## Install & Run

1. Build the parser once (so the viewer consumes the latest build):
   ```sh
   cd ../pdb-parser
   pnpm run build
   ```

2. Install viewer deps and start dev server:
   ```sh
   cd ../pdb-viewer
   pnpm install
   pnpm run dev
   ```

Open the printed local URL (typically http://localhost:5173). The default model path is `/models/1IGY.pdb`.

## Controls (Leva)

- **Parse**
  - `altLocPolicy`: `occupancy` (default) or `all`
  - `modelSelection`: number (1‑based)
  - `bondPolicy`: `conect+heuristic` (default), `conect-only`, or `heuristic-if-missing`

- **Render**
  - `atoms`, `bonds`, `backbone`: toggles
  - `sphereDetail`: sphere subdivisions for atoms
  - `radiusScale`: global multiplier applied to atom radii (default smaller spheres)
  - `materialKind`: `basic` (unlit), `lambert`, or `standard`
  - `background`: canvas background color

## Color notes

- The parser fills `scene.atoms.colors` with CPK element colors (RGB 0–255), and the atoms mesh uses per‑instance colors.
- In Three.js, when per‑vertex/instance colors are enabled, the final color is `material.color × instanceColor × lighting`.
- If you want strictly uniform coloring (ignoring CPK), you can disable vertex colors and set a solid `material.color` in `src/viewer/MoleculeView.tsx` after `makeAtomsMesh(...)`:
  ```ts
  const mat = atoms.material as any;
  mat.vertexColors = false;
  mat.color.set('#ffffff');
  mat.needsUpdate = true;
  ```
  To use CPK instead, keep `vertexColors` enabled and ensure the base `material.color` is white.

## Assets & layout

- The default PDB fixture lives at `public/models/1IGY.pdb`.
- The canvas spans the full viewport; layout is kept minimal and adaptable.

## Troubleshooting

- **Colors look black**: ensure you rebuilt `../pdb-parser` and restarted the viewer. Try `materialKind = basic` to check colors without lighting. CPK requires `vertexColors = true` with a white base color.
- **No bonds in proteins**: set `bondPolicy = conect+heuristic` (default here) so bonds are inferred when `CONECT` is sparse.
- **Peer warnings**: React 19 vs libs expecting 18 may produce warnings; they’re non‑blocking here.

## License

Apache 2.0. See `LICENSE.md`.
