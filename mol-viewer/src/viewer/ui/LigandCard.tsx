/*
 Title: LigandCard
 Description: A ligand's identity, its interactions, a swap-and-compare table (the original ligand as the
 reference row, then the protein's known binders or search results, with their strongest measured potency
 and the difference from the original), and the measured affinities of the molecule in the pocket (the
 swapped-in one, if any), strongest first, each linked to its source. Data is fetched when shown.
*/
import { useEffect, useState } from "react";
import { INTERACTION_COLORS, type Interaction, type InteractionType } from "mol-renderer";
import { ligandInfo, moleculeAffinities, strongest, type Affinity, type LigandInfo } from "../../lib/ligandInfo";
import { knownBinders, searchCandidates, type Candidate } from "../../lib/candidates";

export interface SwapState {
  candidate: Candidate;
  status: "loading" | "ready" | "error";
  error?: string;
  /** Pose fit once aligned: shape overlap with the original (0..1) and heavy-atom clashes. */
  fit?: { shape: number; clashes: number };
}

const SWAP_COLOR = "#c084fc";
const MAX_ROWS = 30;
const isChemblId = (id: string) => /^CHEMBL\d+$/.test(id);
const fmt = (v: number) => (Math.abs(v) >= 1000 || Math.abs(v) < 0.01 ? v.toExponential(2) : String(+v.toPrecision(3)));
const affinityText = (a: Affinity) => `${a.type} ${a.relation !== "=" ? `${a.relation} ` : ""}${fmt(a.value)} ${a.unit}`;
// Strongest first: ChEMBL by pChEMBL, then the rest in source order
const byStrength = (a: Affinity, b: Affinity) => (b.pchembl ?? -Infinity) - (a.pchembl ?? -Infinity);
const heading = "text-[11px] font-semibold uppercase tracking-wider";

const INTERACTION_NAMES: Record<InteractionType, string> = {
  metal: "Metal", salt: "Salt bridge", hbond: "H-bond", pi: "π-stacking", hydrophobic: "Hydrophobic",
};

function InteractionList({ interactions }: { interactions: Interaction[] }) {
  if (interactions.length === 0) return <div className="text-(--ui-muted)">No contacts with the polymer.</div>;
  return (
    <table className="w-full font-mono">
      <tbody>
        {interactions.map((it, k) => (
          <tr key={k} className="border-t border-(--ui-border)">
            <td className="py-0.5 pr-2 whitespace-nowrap">
              <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: INTERACTION_COLORS[it.type] }} />
              {INTERACTION_NAMES[it.type]}{it.detail ? ` (${it.detail})` : ""}
            </td>
            <td className="pr-2" title={`${it.ligandAtom} → ${it.residue} ${it.residueAtom}`}>{it.residue} {it.residueAtom}</td>
            <td className="pr-1 text-right whitespace-nowrap">{it.distance.toFixed(2)} Å</td>
            <td className="text-right whitespace-nowrap text-(--ui-muted)">{it.angle !== undefined ? `${it.angle.toFixed(0)}°` : ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Strongest measurement and its difference from the reference, as table cells. */
function PotencyCells({ best, reference }: { best?: Affinity; reference?: number }) {
  const delta = best?.pchembl !== undefined && reference !== undefined ? best.pchembl - reference : undefined;
  return (
    <>
      <td className="pr-2 text-right whitespace-nowrap font-mono">{best ? affinityText(best) : "—"}</td>
      <td className="pr-2 text-right font-mono">{best?.pchembl?.toFixed(1) ?? ""}</td>
      <td className={`pr-2 text-right font-mono ${delta === undefined ? "" : delta > 0 ? "text-emerald-500" : delta < 0 ? "text-rose-400" : ""}`}>
        {delta === undefined ? "" : `${delta > 0 ? "+" : ""}${delta.toFixed(1)}`}
      </td>
    </>
  );
}

interface SwapCompareProps {
  pdbId?: string;
  reference: { name: string; best?: Affinity };
  swap: SwapState | null;
  onSwap: (c: Candidate) => void;
  onClearSwap: () => void;
}

/** The original ligand, then known binders or search results, side by side by measured potency. */
function SwapCompare({ pdbId, reference, swap, onSwap, onClearSwap }: SwapCompareProps) {
  const [query, setQuery] = useState("");
  const [list, setList] = useState<{ items?: Candidate[]; error?: string; loading?: boolean }>({ loading: true });
  useEffect(() => {
    let live = true;
    setList({ loading: true });
    const q = query.trim();
    const t = setTimeout(() => {
      const p = q ? searchCandidates(q) : pdbId ? knownBinders(pdbId) : Promise.resolve([]);
      // Search results come without measurements: fetch each one's on this protein
      p.then((items) => (q && pdbId
        ? Promise.all(items.map(async (c) => (isChemblId(c.id) ? { ...c, best: strongest(await moleculeAffinities(pdbId, c.id)) } : c)))
        : items))
        .then((items) => { if (live) setList({ items }); })
        .catch((e) => { if (live) setList({ error: e instanceof Error ? e.message : String(e) }); });
    }, q ? 400 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [pdbId, query]);

  const ref = reference.best?.pchembl;
  const swapped = swap?.status === "ready" ? swap.candidate.id : undefined;
  return (
    <div className="space-y-1.5">
      <div className={`${heading} text-(--ui-fg)`}>Swap &amp; compare</div>
      {swap && swap.status !== "ready" && (
        <div className="rounded bg-(--ui-input) px-2 py-1">
          {swap.status === "loading" ? `Fetching 3D structure of ${swap.candidate.name}…` : <span className="text-red-400">{swap.candidate.name}: {swap.error}</span>}
        </div>
      )}
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Name, ChEMBL ID or SMILES (empty: known binders)"
        spellCheck={false}
        className="w-full rounded bg-(--ui-input) px-2 py-1 text-(--ui-fg) placeholder-(--ui-muted) outline-none focus:ring-1 focus:ring-(--ui-active)"
      />
      <div className="max-h-64 overflow-y-auto">
        <table className="w-full">
          <thead>
            <tr className="text-left text-(--ui-muted)">
              <th className="pr-2 font-normal">Ligand</th>
              <th className="pr-2 text-right font-normal">Strongest</th>
              <th className="pr-2 text-right font-normal" title="−log₁₀ molar potency">pChEMBL</th>
              <th className="pr-2 text-right font-normal" title="Difference from the original ligand (positive: stronger)">Δ</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr className="border-t border-(--ui-border) font-medium">
              <td className="py-0.5 pr-2">
                <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: "#fcd1a5" }} />
                {reference.name} <span className="font-normal text-(--ui-muted)">(original)</span>
              </td>
              <PotencyCells best={reference.best} />
              <td className="text-right">
                {swapped ? <button className="rounded px-1.5 py-0.5 hover:bg-(--ui-hover)" onClick={onClearSwap}>Restore</button> : <span className="px-1.5 text-(--ui-muted)">in pocket</span>}
              </td>
            </tr>
            {list.loading ? <tr><td colSpan={5} className="py-1 text-(--ui-muted)">Loading…</td></tr>
              : list.error ? <tr><td colSpan={5} className="py-1 text-red-400">{list.error}</td></tr>
              : !list.items?.length ? <tr><td colSpan={5} className="py-1 text-(--ui-muted)">{query.trim() ? "No matches." : "No known binders of this protein in ChEMBL."}</td></tr>
              : list.items.map((c) => (
                <tr key={c.id} className="border-t border-(--ui-border)">
                  <td className="max-w-40 truncate py-0.5 pr-2" title={c.smiles}>
                    {swapped === c.id && <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: SWAP_COLOR }} />}
                    {c.name}
                  </td>
                  <PotencyCells best={c.best} reference={ref} />
                  <td className="text-right whitespace-nowrap">
                    {swapped === c.id ? <span className="px-1.5 text-(--ui-muted)">in pocket</span>
                      : swap?.status === "loading" && swap.candidate.id === c.id ? <span className="px-1.5 text-(--ui-muted)">…</span>
                      : <button className="rounded px-1.5 py-0.5 hover:bg-(--ui-hover)" onClick={() => onSwap(c)}>Swap in</button>}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      {swap?.status === "ready" && swap.fit && (
        <div className="text-(--ui-muted)">
          <span className="text-(--ui-fg)">{swap.candidate.name}</span> aligned onto {reference.name}: shape overlap {Math.round(swap.fit.shape * 100)} %,{" "}
          <span className={swap.fit.clashes > 0 ? "text-rose-400" : ""}>{swap.fit.clashes} clash{swap.fit.clashes === 1 ? "" : "es"}</span> (heavy atoms within 2.5 Å).
          A pose hypothesis that assumes the original's binding mode; it doesn't change measured affinities.
        </div>
      )}
      {!query.trim() && !list.loading && !!list.items?.length && <div className="text-(--ui-muted)">Known binders of this protein, strongest first. pChEMBL compares Ki, Kd, IC50 and EC50 on one scale.</div>}
    </div>
  );
}

export interface LigandCardProps {
  pdbId?: string;
  compId: string;
  interactions: Interaction[];
  swap: SwapState | null;
  onSwap: (c: Candidate) => void;
  onClearSwap: () => void;
}

export function LigandCard({ pdbId, compId, interactions, swap, onSwap, onClearSwap }: LigandCardProps) {
  const [state, setState] = useState<{ info?: LigandInfo; error?: string }>({});
  useEffect(() => {
    if (!pdbId) { setState({ error: "No PDB entry ID for this structure." }); return; }
    let live = true;
    setState({});
    ligandInfo(pdbId, compId)
      .then((info) => { if (live) setState({ info }); })
      .catch((e) => { if (live) setState({ error: e instanceof Error ? e.message : String(e) }); });
    return () => { live = false; };
  }, [pdbId, compId]);

  // Measurements of the molecule in the pocket: the swapped-in one, or the original
  const swappedId = swap?.status === "ready" ? swap.candidate.id : undefined;
  const [swappedRows, setSwappedRows] = useState<{ id?: string; rows?: Affinity[]; error?: string }>({});
  useEffect(() => {
    if (!swappedId || !pdbId) { setSwappedRows({}); return; }
    if (!isChemblId(swappedId)) { setSwappedRows({ id: swappedId, rows: [] }); return; }
    let live = true;
    setSwappedRows({ id: swappedId });
    moleculeAffinities(pdbId, swappedId)
      .then((rows) => { if (live) setSwappedRows({ id: swappedId, rows }); })
      .catch((e) => { if (live) setSwappedRows({ id: swappedId, error: e instanceof Error ? e.message : String(e) }); });
    return () => { live = false; };
  }, [pdbId, swappedId]);

  const { info, error } = state;
  const reference = { name: info?.name && info.name.length <= 24 ? info.name : compId, best: info ? strongest(info.affinities) : undefined };
  const activeName = swappedId ? swap!.candidate.name : reference.name;
  const activeRows = swappedId ? swappedRows.rows : info?.affinities;
  const activeError = swappedId ? swappedRows.error : error;
  const rows = [...(activeRows ?? [])].sort(byStrength);
  const types = [...new Set(rows.map((r) => r.type))];

  return (
    <div className="space-y-2 text-xs">
      {info && (
        <div>
          <div className="font-medium text-(--ui-strong)">{info.name ?? compId}</div>
          <div className="text-(--ui-muted)">
            {[info.formula, info.weight ? `${info.weight.toFixed(1)} Da` : undefined].filter(Boolean).join(" · ")}
            {info.chemblId && (
              <> · <a className="underline hover:text-(--ui-strong)" href={`https://www.ebi.ac.uk/chembl/compound_report_card/${info.chemblId}/`} target="_blank" rel="noreferrer">{info.chemblId}</a></>
            )}
          </div>
          {info.chemblByConnectivity && <div className="text-(--ui-muted)">ChEMBL match ignores stereochemistry (same connectivity).</div>}
        </div>
      )}
      <div className="space-y-1">
        <div className={`${heading} text-(--ui-muted)`}>Interactions</div>
        <InteractionList interactions={interactions} />
      </div>
      <SwapCompare pdbId={pdbId} reference={reference} swap={swap} onSwap={onSwap} onClearSwap={onClearSwap} />
      <div className={`${heading} text-(--ui-muted)`}>Measured affinities · {activeName}</div>
      {activeError ? <div className="text-red-400">{activeError}</div>
        : !activeRows ? <div className="text-(--ui-muted)">Loading…</div>
        : rows.length === 0 ? <div className="text-(--ui-muted)">No measured affinities for this molecule on this protein.</div>
        : (
          <>
            <div className="text-(--ui-muted)">{rows.length} measurement{rows.length > 1 ? "s" : ""} ({types.join(", ")})</div>
            <table className="w-full font-mono">
              <tbody>
                {rows.slice(0, MAX_ROWS).map((r, k) => (
                  <tr key={k} className="border-t border-(--ui-border)" title={r.assay}>
                    <td className="py-0.5 pr-2">{r.type}</td>
                    <td className="pr-2 text-right whitespace-nowrap">{r.relation !== "=" ? `${r.relation} ` : ""}{fmt(r.value)} {r.unit}</td>
                    <td className="pr-2 text-right text-(--ui-muted)">{r.pchembl !== undefined ? r.pchembl.toFixed(1) : ""}</td>
                    <td className="text-right">
                      {r.link ? <a className="underline hover:text-(--ui-strong)" href={r.link} target="_blank" rel="noreferrer">{r.source}</a> : r.source}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > MAX_ROWS && <div className="text-(--ui-muted)">Showing the {MAX_ROWS} strongest.</div>}
          </>
        )}
      <div className="border-t border-(--ui-border) pt-1.5 text-[10px] text-(--ui-muted)">
        Data: RCSB PDB (BindingDB), ChEMBL (CC BY-SA 3.0). pChEMBL = −log₁₀ molar potency.
      </div>
    </div>
  );
}
