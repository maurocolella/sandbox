/*
 Title: candidates
 Description: Ligands to swap into a pocket, and their 3D structures:
 - Known binders of the entry's protein: ChEMBL measurements on its targets (by UniProt), best per molecule.
 - Search by ChEMBL ID, name (ChEMBL search) or SMILES.
 - 3D conformers from PubChem (by SMILES), as SDF; hydrogens dropped, like crystal ligands.
*/
import { entryUniprots, chemblTargets, type Affinity } from "./ligandInfo";

const CHEMBL = "https://www.ebi.ac.uk/chembl/api/data";
const PUBCHEM = "https://pubchem.ncbi.nlm.nih.gov/rest/pug";

export interface Candidate {
  id: string; // ChEMBL ID, or the SMILES itself
  name: string;
  smiles: string;
  best?: Affinity; // strongest measurement on this protein
}

export interface Molecule3D {
  elements: string[];
  positions: Float32Array; // xyz, Å
  bonds: [number, number][];
}

const getJson = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
};

const binderCache = new Map<string, Promise<Candidate[]>>();

/** The protein's known binders, strongest first (top `limit` molecules). */
export function knownBinders(pdbId: string, limit = 30): Promise<Candidate[]> {
  const id = pdbId.toUpperCase();
  let p = binderCache.get(id);
  if (!p) {
    p = (async () => {
      const targets = await chemblTargets(await entryUniprots(id));
      if (targets.length === 0) return [];
      const json = await getJson(`${CHEMBL}/activity?target_chembl_id__in=${targets.join(",")}&standard_type__in=Ki,Kd,IC50,EC50`
        + `&pchembl_value__isnull=false&order_by=-pchembl_value&limit=500&format=json`
        + `&only=molecule_chembl_id,molecule_pref_name,canonical_smiles,standard_type,standard_relation,standard_value,standard_units,pchembl_value`);
      const seen = new Set<string>(), out: Candidate[] = [];
      for (const a of json.activities ?? []) {
        if (!a.canonical_smiles || seen.has(a.molecule_chembl_id) || a.standard_value == null) continue;
        seen.add(a.molecule_chembl_id);
        out.push({
          id: a.molecule_chembl_id, name: a.molecule_pref_name ?? a.molecule_chembl_id, smiles: a.canonical_smiles,
          best: { type: a.standard_type, relation: a.standard_relation ?? "=", value: Number(a.standard_value), unit: a.standard_units ?? "", pchembl: Number(a.pchembl_value), source: "ChEMBL" },
        });
        if (out.length >= limit) break;
      }
      return out;
    })();
    p.catch(() => binderCache.delete(id));
    binderCache.set(id, p);
  }
  return p;
}

// SMILES use characters names don't: ring bonds, branches, brackets, aromatic lowercase next to digits...
const looksLikeSmiles = (q: string) => !/\s/.test(q) && /[=#()[\]@+\\/]|[a-z]\d|\d[a-z]/.test(q);

/** Candidates for a ChEMBL ID, a SMILES string, or a name. */
export async function searchCandidates(query: string): Promise<Candidate[]> {
  const q = query.trim();
  if (!q) return [];
  if (/^CHEMBL\d+$/i.test(q)) {
    const m = await getJson(`${CHEMBL}/molecule/${q.toUpperCase()}?format=json&only=molecule_chembl_id,pref_name,molecule_structures`);
    const smiles = m.molecule_structures?.canonical_smiles;
    return smiles ? [{ id: m.molecule_chembl_id, name: m.pref_name ?? m.molecule_chembl_id, smiles }] : [];
  }
  if (looksLikeSmiles(q)) return [{ id: q, name: "SMILES input", smiles: q }];
  const json = await getJson(`${CHEMBL}/molecule/search?q=${encodeURIComponent(q)}&limit=10&format=json&only=molecule_chembl_id,pref_name,molecule_structures`);
  return (json.molecules ?? [])
    .filter((m: { molecule_structures?: { canonical_smiles?: string } }) => m.molecule_structures?.canonical_smiles)
    .map((m: { molecule_chembl_id: string; pref_name?: string; molecule_structures: { canonical_smiles: string } }) => ({ id: m.molecule_chembl_id, name: m.pref_name ?? m.molecule_chembl_id, smiles: m.molecule_structures.canonical_smiles }));
}

/** Heavy atoms and bonds of a V2000 SDF (first record). */
function parseSdf(text: string): Molecule3D {
  const lines = text.split(/\r?\n/);
  const counts = lines[3] ?? "";
  const nAtoms = parseInt(counts.slice(0, 3), 10), nBonds = parseInt(counts.slice(3, 6), 10);
  if (!(nAtoms > 0)) throw new Error("No atoms in the structure");
  const keep = new Int32Array(nAtoms).fill(-1);
  const elements: string[] = [], coords: number[] = [];
  for (let i = 0; i < nAtoms; i++) {
    const l = lines[4 + i]!;
    const el = l.slice(31, 34).trim();
    if (el === "H") continue;
    keep[i] = elements.length;
    elements.push(el);
    coords.push(parseFloat(l.slice(0, 10)), parseFloat(l.slice(10, 20)), parseFloat(l.slice(20, 30)));
  }
  const bonds: [number, number][] = [];
  for (let k = 0; k < nBonds; k++) {
    const l = lines[4 + nAtoms + k]!;
    const a = keep[parseInt(l.slice(0, 3), 10) - 1]!, b = keep[parseInt(l.slice(3, 6), 10) - 1]!;
    if (a >= 0 && b >= 0) bonds.push([a, b]);
  }
  return { elements, positions: Float32Array.from(coords), bonds };
}

const conformerCache = new Map<string, Promise<Molecule3D>>();

/** A 3D conformer from PubChem (computed conformers exist for most drug-like molecules). */
export function conformer3D(smiles: string): Promise<Molecule3D> {
  let p = conformerCache.get(smiles);
  if (!p) {
    // Form-encoded POST: SMILES characters (/, #, +) would need care in a path
    p = fetch(`${PUBCHEM}/compound/smiles/SDF?record_type=3d`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `smiles=${encodeURIComponent(smiles)}`,
    }).then(async (res) => {
      if (res.status === 404) throw new Error("PubChem has no 3D conformer for this molecule");
      if (!res.ok) throw new Error(`PubChem: ${res.status} ${res.statusText}`);
      return parseSdf(await res.text());
    });
    p.catch(() => conformerCache.delete(smiles));
    conformerCache.set(smiles, p);
  }
  return p;
}
