/*
 Title: ligandInfo
 Description: Identity and measured affinities of an entry's ligand, from public APIs (both allow browser
 requests):
 - RCSB Data API (GraphQL): chemical name, formula, weight, InChIKey, the protein's UniProt accessions, and
   the entry's binding affinities (currently BindingDB only, and for few entries).
 - ChEMBL: the ligand by InChIKey (or, failing that, by its connectivity block, which ignores
   stereochemistry), the protein's targets by UniProt accession, and Ki/Kd/IC50/EC50 measurements of that
   ligand on those targets.
 Results are cached per entry and ligand.
*/

export interface Affinity {
  type: string; // Ki, Kd, IC50, EC50, ΔG...
  relation: string; // =, <, >, ~
  value: number;
  unit: string;
  pchembl?: number; // -log10(molar), ChEMBL's comparable potency
  source: string; // BindingDB, ChEMBL
  link?: string;
  assay?: string;
}

export interface LigandInfo {
  compId: string;
  name?: string;
  formula?: string;
  weight?: number; // Da
  chemblId?: string;
  /** Matched only by connectivity (a stereoisomer or racemate of the bound form). */
  chemblByConnectivity?: boolean;
  affinities: Affinity[];
}

interface EntryData {
  uniprots: string[];
  comps: Map<string, { name: string; formula: string; weight: number; inchiKey?: string }>;
  rcsb: Map<string, Affinity[]>;
}

const RCSB = "https://data.rcsb.org/graphql";
const CHEMBL = "https://www.ebi.ac.uk/chembl/api/data";
const entryCache = new Map<string, Promise<EntryData>>();
const targetCache = new Map<string, Promise<string[]>>();
const infoCache = new Map<string, Promise<LigandInfo>>();

const getJson = async (url: string, init?: RequestInit) => {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
};

// RCSB writes Greek letters as HTML entities ("&Delta;G")
const decodeEntities = (s: string) => s.replace(/&Delta;/g, "Δ").replace(/&amp;/g, "&");

function entryData(pdbId: string): Promise<EntryData> {
  const id = pdbId.toUpperCase();
  let p = entryCache.get(id);
  if (!p) {
    const query = `{ entry(entry_id: "${id}") {
      rcsb_binding_affinity { comp_id type value unit symbol provenance_code link }
      polymer_entities { rcsb_polymer_entity_container_identifiers { uniprot_ids } }
      nonpolymer_entities { nonpolymer_comp { chem_comp { id name formula formula_weight } rcsb_chem_comp_descriptor { InChIKey } } }
    } }`;
    p = getJson(RCSB, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }) }).then((json) => {
      const e = json?.data?.entry;
      if (!e) throw new Error(`No RCSB entry ${id}`);
      const uniprots = [...new Set<string>((e.polymer_entities ?? []).flatMap((pe: { rcsb_polymer_entity_container_identifiers?: { uniprot_ids?: string[] } }) => pe.rcsb_polymer_entity_container_identifiers?.uniprot_ids ?? []))];
      const comps: EntryData["comps"] = new Map();
      for (const ne of e.nonpolymer_entities ?? []) {
        const c = ne.nonpolymer_comp?.chem_comp;
        if (!c?.id) continue;
        comps.set(c.id, { name: c.name, formula: c.formula, weight: c.formula_weight, inchiKey: ne.nonpolymer_comp?.rcsb_chem_comp_descriptor?.InChIKey });
      }
      const rcsb: EntryData["rcsb"] = new Map();
      for (const a of e.rcsb_binding_affinity ?? []) {
        // A zero Kd/Ki/IC50 is a value lost to rounding upstream (e.g. biotin-streptavidin, ~1e-14 M); energies may be negative
        if (a.value <= 0 && !/&Delta;|Δ/.test(a.type)) continue;
        const list = rcsb.get(a.comp_id) ?? [];
        list.push({ type: decodeEntities(a.type), relation: a.symbol ?? "=", value: a.value, unit: a.unit, source: a.provenance_code, link: a.link });
        rcsb.set(a.comp_id, list);
      }
      return { uniprots, comps, rcsb };
    });
    p.catch(() => entryCache.delete(id)); // retry on a later open
    entryCache.set(id, p);
  }
  return p;
}

/** UniProt accessions of an entry's polymers. */
export const entryUniprots = (pdbId: string) => entryData(pdbId).then((e) => e.uniprots);

/** ChEMBL single-protein or complex targets with a component among the given UniProt accessions. */
export function chemblTargets(uniprots: string[]): Promise<string[]> {
  const key = [...uniprots].sort().join(",");
  let p = targetCache.get(key);
  if (!p) {
    p = uniprots.length === 0
      ? Promise.resolve([])
      : getJson(`${CHEMBL}/target?target_components__accession__in=${key}&target_type__in=SINGLE PROTEIN,PROTEIN COMPLEX&only=target_chembl_id&limit=100&format=json`)
        .then((j) => (j.targets ?? []).map((t: { target_chembl_id: string }) => t.target_chembl_id));
    p.catch(() => targetCache.delete(key));
    targetCache.set(key, p);
  }
  return p;
}

async function chemblMolecule(inchiKey: string): Promise<{ id: string; byConnectivity: boolean } | null> {
  const only = "&only=molecule_chembl_id&format=json";
  const exact = await getJson(`${CHEMBL}/molecule?molecule_structures__standard_inchi_key=${inchiKey}${only}`);
  if (exact.molecules?.[0]) return { id: exact.molecules[0].molecule_chembl_id, byConnectivity: false };
  const block = inchiKey.split("-")[0];
  const near = await getJson(`${CHEMBL}/molecule?molecule_structures__standard_inchi_key__startswith=${block}${only}&limit=1`);
  return near.molecules?.[0] ? { id: near.molecules[0].molecule_chembl_id, byConnectivity: true } : null;
}

export function ligandInfo(pdbId: string, compId: string): Promise<LigandInfo> {
  const key = `${pdbId.toUpperCase()}/${compId}`;
  let p = infoCache.get(key);
  if (!p) {
    p = (async () => {
      const entry = await entryData(pdbId);
      const comp = entry.comps.get(compId);
      const info: LigandInfo = { compId, name: comp?.name, formula: comp?.formula, weight: comp?.weight, affinities: [...(entry.rcsb.get(compId) ?? [])] };
      if (!comp?.inchiKey) return info;
      const [mol, targets] = await Promise.all([chemblMolecule(comp.inchiKey), chemblTargets(entry.uniprots)]);
      if (!mol) return info;
      info.chemblId = mol.id;
      info.chemblByConnectivity = mol.byConnectivity;
      if (targets.length === 0) return info;
      const acts = await getJson(`${CHEMBL}/activity?molecule_chembl_id=${mol.id}&target_chembl_id__in=${targets.join(",")}`
        + `&standard_type__in=Ki,Kd,IC50,EC50&pchembl_value__isnull=false&limit=200&format=json`
        + `&only=standard_type,standard_relation,standard_value,standard_units,pchembl_value,assay_description,document_chembl_id`);
      for (const a of acts.activities ?? []) {
        if (a.standard_value == null) continue; // reported without a number
        info.affinities.push({
          type: a.standard_type, relation: a.standard_relation ?? "=", value: Number(a.standard_value), unit: a.standard_units ?? "",
          pchembl: a.pchembl_value != null ? Number(a.pchembl_value) : undefined, source: "ChEMBL", assay: a.assay_description ?? undefined,
          link: a.document_chembl_id ? `https://www.ebi.ac.uk/chembl/document_report_card/${a.document_chembl_id}/` : undefined,
        });
      }
      return info;
    })();
    p.catch(() => infoCache.delete(key));
    infoCache.set(key, p);
  }
  return p;
}
