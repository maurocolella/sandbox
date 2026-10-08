/*
 Title: LigandCard
 Description: A ligand's identity and measured affinities (RCSB, ChEMBL), strongest first, each linked to its
 source; fetched when shown.
*/
import { useEffect, useState } from "react";
import { INTERACTION_COLORS, type Interaction, type InteractionType } from "mol-renderer";
import { ligandInfo, type Affinity, type LigandInfo } from "../../lib/ligandInfo";

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

const MAX_ROWS = 30;

const fmt = (v: number) => (Math.abs(v) >= 1000 || Math.abs(v) < 0.01 ? v.toExponential(2) : String(+v.toPrecision(3)));
// Strongest first: ChEMBL by pChEMBL, then the rest in source order
const byStrength = (a: Affinity, b: Affinity) => (b.pchembl ?? -Infinity) - (a.pchembl ?? -Infinity);

export function LigandCard({ pdbId, compId, interactions }: { pdbId?: string; compId: string; interactions: Interaction[] }) {
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
  const contacts = (
    <div className="space-y-1">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-(--ui-muted)">Interactions</div>
      <InteractionList interactions={interactions} />
    </div>
  );
  if (error) return <div className="space-y-2 text-xs">{contacts}<div className="text-red-400">{error}</div></div>;
  if (!info) return <div className="space-y-2 text-xs">{contacts}<div className="text-(--ui-muted)">Loading affinities…</div></div>;
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
      {contacts}
      <div className="text-[11px] font-semibold uppercase tracking-wider text-(--ui-muted)">Measured affinities</div>
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
