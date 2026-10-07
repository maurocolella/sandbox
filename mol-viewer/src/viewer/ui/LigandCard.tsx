/*
 Title: LigandCard
 Description: A ligand's identity and measured affinities (RCSB, ChEMBL), strongest first, each linked to its
 source; fetched when shown.
*/
import { useEffect, useState } from "react";
import { ligandInfo, type Affinity, type LigandInfo } from "../../lib/ligandInfo";

const MAX_ROWS = 30;

const fmt = (v: number) => (Math.abs(v) >= 1000 || Math.abs(v) < 0.01 ? v.toExponential(2) : String(+v.toPrecision(3)));
// Strongest first: ChEMBL by pChEMBL, then the rest in source order
const byStrength = (a: Affinity, b: Affinity) => (b.pchembl ?? -Infinity) - (a.pchembl ?? -Infinity);

export function LigandCard({ pdbId, compId }: { pdbId?: string; compId: string }) {
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

  const { info, error } = state;
  if (error) return <div className="text-xs text-red-400">{error}</div>;
  if (!info) return <div className="text-xs text-(--ui-muted)">Loading…</div>;
  const rows = [...info.affinities].sort(byStrength);
  const types = [...new Set(rows.map((r) => r.type))];

  return (
    <div className="space-y-2 text-xs">
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
      {rows.length === 0 ? (
        <div className="text-(--ui-muted)">No measured affinities for this ligand on this protein.</div>
      ) : (
        <>
          <div className="text-(--ui-muted)">{rows.length} measurement{rows.length > 1 ? "s" : ""} ({types.join(", ")})</div>
          <div>
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
          </div>
          {rows.length > MAX_ROWS && <div className="text-(--ui-muted)">Showing the {MAX_ROWS} strongest.</div>}
        </>
      )}
      <div className="border-t border-(--ui-border) pt-1.5 text-[10px] text-(--ui-muted)">
        Data: RCSB PDB (BindingDB), ChEMBL (CC BY-SA 3.0). pChEMBL = −log₁₀ molar potency.
      </div>
    </div>
  );
}
