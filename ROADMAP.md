# Roadmap

Last updated: 2026-10-14.

A checklist: a box is checked when its feature lands, and items are never removed.

## Goal

A demonstrator for computational chemists: open a structure, find its pockets, swap in ligands from public databases, compare their measured affinities, and judge how each one fits (alignment, angles, interactions, clashes), adjusting the pose by hand. Docking is an optional "auto-place", not the core.

## Design principle

Render the chemistry, not only the atoms, and show how far the structure can be trusted. A chemist reads a structure as chemistry: bond orders, charges, hydrogen-bond directions, which parts of the model the data supports. Where the viewer shows only geometry, they have to infer the rest. PyMOL remains the reference for the look.

## Done

- [x] Pockets: LIGSITE-style detection, drawn as the surface of their lining residues and streamed in nearest the camera first. With the molecular surface on, they're painted onto it.
- [x] Molecular surfaces (VDW, SAS, SES), streamed by region from a worker pool.
- [x] Ligand cards: identity and measured affinities from RCSB and ChEMBL.
- [x] PLIP-style interactions (H-bonds, salt bridges, π-stacking, hydrophobic, metal) as dashed lines with distances.
- [x] Binding-site sticks, with labels prioritised and faded by depth.
- [x] Swap from ChEMBL or PubChem, with a swap-and-compare table (Δ pChEMBL).
- [x] Initial alignment of a swapped ligand onto the original (shape overlap with a clash penalty).

## 1. Core loop: swap, fit, compare

The heart of the demonstrator, in order.

- [ ] **D. Interactive tweak.** Handles to rotate and move the swapped ligand. Its interactions, binding-site sticks, clashes and fit score update live; today they still describe the original ligand.
- [ ] **Clashes drawn, not just counted.** Mark overlapping atoms in the scene.
- [ ] **E. Fit columns in the comparison table.** Contacts, clashes and a pose-fit score next to measured potency, labelled as pose-based.
- [ ] **On swap:** zoom the camera to the pocket, and optionally hide the original ligand.
- [ ] **Ligand card position:** a better default, since it opens over the pocket.

## 2. Chemical meaning

What a chemist expects to see and doesn't yet.

- [x] **Bond orders and aromaticity.** Double bonds, and the dashed inner line of aromatic rings. Crystal ligands' chemical definitions and PubChem's SDF both carry them; check first what our parsers keep.
- [x] **2D ligand drawing and interaction map.** The flat structure and the LigPlot-style interaction diagram that chemists reason with, alongside the 3D view.
- [x] **Surface colouring by property.** Electrostatics (charge) or hydrophobicity, to see where a polar or a greasy group belongs. Builds on the per-vertex atom colouring now in place.
- [ ] **Formal charges and protonation states.** Which groups are charged at physiological pH; decides which salt bridges and H-bonds are real.
- [ ] **Polar hydrogens.** H-bonds have a direction (donor H to acceptor); without hydrogens it can't be judged.
- [ ] **Bridging waters.** Many key interactions run ligand to water to protein; waters are currently left out of interactions and pockets.
- [ ] **More interaction types:** halogen bonds, cation–π.
- [ ] **Pocket properties:** volume, polarity and a druggability estimate, beyond the current score.
- [ ] **Ligand properties:** molecular weight, logP, H-bond donors and acceptors, polar surface area, and ligand efficiency (affinity per heavy atom), so Δ pChEMBL comparisons are meaningful.
- [ ] **Internal strain.** Whether a pose forces the ligand into a shape it wouldn't naturally take.

## 3. Trust in the structure

What an expert checks before believing a pose.

- [ ] **Resolution and B-factors.** Colour the ligand and nearby residues by B-factor, to show well-defined parts versus guesswork.
- [ ] **Alternate conformations and occupancy.** Residues and ligands modelled in more than one position.
- [ ] **Electron density fit.** Whether the experimental data supports the ligand pose.

## 4. Polish

From an external review.

- [ ] **Affinity aggregation.** Group measurements by type (median and range), with drill-down to individual assays. Also hides the 200-measurement fetch cap.
- [ ] **Progressive residue labels.** Fewer labels by default, more on demand. Partly done: labels are prioritised and fade with depth.
- [ ] **Side-by-side ligand comparison**, beyond the comparison table.

## 5. Later

- [ ] **Auto-place by docking.** Boltz-2 through NVIDIA's hosted API, called from a Vercel function. Needs an NVIDIA API key.
- [ ] **Structural alignment (TM-align), in the browser via WebAssembly.** Superimpose other PDB entries of the same or a related protein onto the open one, bringing their ligands along: experimentally observed poses of other binders, in our pocket's frame, to compare against swapped and docked ones.
- [ ] **RDKit in WebAssembly.** 3D structures for molecules PubChem lacks, rotating individual bonds so flexible ligands can adapt, substructure-based alignment, and the 2D drawings and properties above.

## 6. Rendering

- [x] **Path tracing.** Publication-quality renders (soft shadows, ambient occlusion, global illumination) computed on the viewer's GPU in an offscreen buffer, so the interactive view stays responsive. While it converges, the image in progress shows as a thumbnail that refines over time; the finished render can be viewed or saved.

## 7. Viewer fixes

- [ ] **Selection:** "None" still behaves like Atom.
- [ ] **Buried pockets with the surface on.** Pockets with no exposed surface don't show when painted onto it; visible with the surface off or translucent.
- [ ] **Surface draw calls.** A streamed surface is one mesh per region (47 draw calls on 3J2T rather than 6); could be merged once streaming finishes.

## 8. Performance and platform

- [ ] **3J3Q's full overview at about 60 fps.** Suspected per-pixel shading cost of the farthest level of detail; measure GPU time first.
- [ ] **Load time:** about 2 s of main-thread work on giant entries (picking grid, scene handoff).
- [ ] **Hover overlay:** buffers sized to the whole structure.
- [ ] **SES speed:** crease seeds dominate the solvent-excluded surface's compute time.
- [ ] **Level of detail for cartoons.**
- [ ] **Biological assemblies.**
- [ ] **The BinaryCIF format.**
- [ ] **Secondary structure computed when files lack it.**
