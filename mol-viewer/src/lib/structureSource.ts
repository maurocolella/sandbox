/*
 Title: structureSource
 Description: Resolves what the user typed into a fetchable structure URL. Recognises PDB IDs in the classic
 4-character form (digit 1-9 + 3 alphanumerics, e.g. 4HHB) and the extended wwPDB form (pdb_ + 8
 alphanumerics, e.g. pdb_00004hhb), which load as mmCIF from RCSB (the only format every entry has),
 with the legacy PDB file as a fallback; URLs and paths pass through unchanged.
 Anything else (e.g. a half-typed ID) resolves to null so nothing is fetched.
*/

export interface StructureSource {
  url: string;
  /** Tried when `url` can't be fetched or parsed (PDB IDs: the legacy .pdb file). */
  fallbackUrl?: string;
  pdbId?: string; // set when the input was recognised as a PDB ID
}

const rcsb = (id: string): StructureSource => ({
  url: `https://files.rcsb.org/download/${id}.cif`,
  fallbackUrl: `https://files.rcsb.org/download/${id}.pdb`,
  pdbId: id,
});

const CLASSIC_ID = /^[1-9][a-z0-9]{3}$/i;
const EXTENDED_ID = /^pdb_[a-z0-9]{8}$/i;

export function resolveStructureSource(input: string): StructureSource | null {
  const text = input.trim();
  if (!text) return null;
  if (CLASSIC_ID.test(text)) {
    return rcsb(text.toUpperCase());
  }
  if (EXTENDED_ID.test(text)) {
    // Existing entries are classic IDs zero-padded (pdb_00004hhb = 4HHB); show those by their classic id
    const id = text.toLowerCase();
    const classic = /^pdb_0000([1-9][a-z0-9]{3})$/.exec(id)?.[1]?.toUpperCase();
    return rcsb(classic ?? id);
  }
  if (/^https?:\/\//i.test(text) || /^\.{0,2}\//.test(text) || /\.(pdb|ent|cif|mmcif)(\.gz)?$/i.test(text)) {
    return { url: text };
  }
  return null;
}
