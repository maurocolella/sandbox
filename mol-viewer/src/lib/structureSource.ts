/*
 Title: structureSource
 Description: Resolves what the user typed into a fetchable structure URL. Recognises PDB IDs in the classic
 4-character form (digit 1-9 + 3 alphanumerics, e.g. 4HHB) and the extended wwPDB form (pdb_ + 8
 alphanumerics, e.g. pdb_00004hhb), which load from RCSB; URLs and paths pass through unchanged.
 Anything else (e.g. a half-typed ID) resolves to null so nothing is fetched.
*/

export interface StructureSource {
  url: string;
  pdbId?: string; // set when the input was recognised as a PDB ID
}

const CLASSIC_ID = /^[1-9][a-z0-9]{3}$/i;
const EXTENDED_ID = /^pdb_[a-z0-9]{8}$/i;

export function resolveStructureSource(input: string): StructureSource | null {
  const text = input.trim();
  if (!text) return null;
  if (CLASSIC_ID.test(text)) {
    const id = text.toUpperCase();
    return { url: `https://files.rcsb.org/download/${id}.pdb`, pdbId: id };
  }
  if (EXTENDED_ID.test(text)) {
    // Existing entries are classic IDs zero-padded (pdb_00004hhb = 4HHB); RCSB serves the extended
    // form as mmCIF only, so load those through the classic PDB-format file
    const id = text.toLowerCase();
    const classic = /^pdb_0000([1-9][a-z0-9]{3})$/.exec(id)?.[1]?.toUpperCase();
    return { url: `https://files.rcsb.org/download/${classic ?? id}.pdb`, pdbId: classic ?? id };
  }
  if (/^https?:\/\//i.test(text) || /^\.{0,2}\//.test(text) || /\.(pdb|ent)(\.gz)?$/i.test(text)) {
    return { url: text };
  }
  return null;
}
