import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as THREE from "three";

// Import built outputs to validate distribution
import {
  parsePdbToMolScene,
  makeSceneObjects,
  getAtomSelection,
  getBondSelection,
} from "../dist/index.js";

describe("pdb-parser end-to-end", () => {
  const pdbPath = join(__dirname, "fixtures", "1IGY.pdb");
  const pdbText = readFileSync(pdbPath, "utf8");

  it("parses a PDB file into a MolScene with atoms and metadata", () => {
    const scene = parsePdbToMolScene(pdbText, {
      altLocPolicy: "occupancy",
      modelSelection: 1,
      bondPolicy: "heuristic-if-missing",
    });

    expect(scene.atoms.count).toBeGreaterThan(0);
    expect(scene.atoms.positions.length).toBe(scene.atoms.count * 3);
    expect(scene.atoms.radii.length).toBe(scene.atoms.count);

    // tables
    expect(scene.tables?.chains?.length ?? 0).toBeGreaterThan(0);
    expect(scene.tables?.residues?.length ?? 0).toBeGreaterThan(0);
    // chain segmentation
    if (scene.tables?.chainSegments) {
      expect(scene.tables.chainSegments.length).toBeGreaterThan(0);
      for (const seg of scene.tables.chainSegments) {
        expect(seg.endResidue).toBeGreaterThanOrEqual(seg.startResidue);
      }
    }

    // optional bonds
    if (scene.bonds) {
      expect(scene.bonds.count).toBeGreaterThan(0);
      expect(scene.bonds.indexA.length).toBe(scene.bonds.count);
      expect(scene.bonds.indexB.length).toBe(scene.bonds.count);
      if (scene.bonds.order) {
        expect(scene.bonds.order.length).toBe(scene.bonds.count);
      }
    }

    // optional backbone
    if (scene.backbone) {
      expect(scene.backbone.positions.length).toBeGreaterThan(0);
      expect(scene.backbone.segments.length % 2).toBe(0);
      expect(scene.backbone.segments.length).toBeGreaterThan(0);
    }

    // selection helpers
    const atomSel = getAtomSelection(scene, 0);
    expect(atomSel?.atomIndex).toBe(0);
    expect(atomSel?.chain).toBeTruthy();
    expect(atomSel?.residue).toBeTruthy();
    if (atomSel) {
      // format label should be non-empty
      const label = `${atomSel.chain?.id || ""} ${atomSel.residue?.name || ""}`.trim();
      expect(label.length).toBeGreaterThan(0);
    }

    if (scene.bonds && scene.bonds.count > 0) {
      const bondSel = getBondSelection(scene, 0);
      expect(bondSel?.bondIndex).toBe(0);
      expect(bondSel?.a).toBeTruthy();
      expect(bondSel?.b).toBeTruthy();
    }
  });

  it("builds Three.js scene objects from MolScene", () => {
    const scene = parsePdbToMolScene(pdbText, { bondPolicy: "heuristic-if-missing" });
    const objs = makeSceneObjects(scene, { atoms: { sphereDetail: 8 }, bonds: {}, backbone: {} });

    // atoms
    expect(objs.atoms).toBeInstanceOf(THREE.InstancedMesh);

    // bonds/backbone are optional depending on data
    if (objs.bonds) {
      expect(objs.bonds).toBeInstanceOf(THREE.LineSegments);
    }
    if (objs.backbone) {
      expect(objs.backbone).toBeInstanceOf(THREE.LineSegments);
    }
  });
});
