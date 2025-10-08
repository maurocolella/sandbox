# Monorepo overview

This repository hosts multiple, loosely coupled sub-projects used for molecular data parsing and visualization.

## Sub-projects

- **pdb-parser**
  - Lean TypeScript PDB parser that produces a renderer‑agnostic `MolScene` for web visualization. Optional Three.js adapters are provided separately.
  - Docs: `pdb-parser/README.md`
  - License: `pdb-parser/LICENSE` (Apache 2.0)

- **pdb-viewer**
  - React + TypeScript + Vite molecular viewer that consumes `pdb-parser` and renders with Three.js via React Three Fiber (atoms, bonds, backbone).
  - Docs: `pdb-viewer/README.md`
  - License: `pdb-viewer/LICENSE` (Apache 2.0)

## Licensing

Each sub-project is licensed under the terms specified in its own directory. As of now, both `pdb-parser` and `pdb-viewer` are under the Apache License 2.0. Refer to their respective `LICENSE` files for full terms.

If you add new projects to this repo, include a `LICENSE` and a `README.md` in each project directory to declare their respective terms and usage.
