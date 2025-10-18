/*
 Title: StructureControls
 Description: Sidebar UI component for loading a PDB source URL and toggling chain visibility.
 Renders inputs and checkboxes and delegates actions via props callbacks.
*/
import { useMemo } from "react";
import type { MolScene } from "pdb-parser";

export interface StructureControlsProps {
    scene: MolScene | null;
    sourceUrl: string;
    onSourceUrlChange: (value: string) => void;
    chainSelected: Record<number, boolean>;
    onToggleChain: (idx: number, checked: boolean) => void;
    onAllChains: () => void;
    onNoChains: () => void;
}

export function StructureControls(props: StructureControlsProps) {
    const chains = useMemo(() => (props.scene?.tables?.chains ? props.scene.tables.chains : []), [props.scene]);
    return (
        <div className="rounded-lg bg-zinc-900/80 p-3 text-zinc-200 backdrop-blur">
            <div className="mb-2 text-sm font-semibold">Load file</div>
            <input
                type="text"
                value={props.sourceUrl}
                onChange={(e) => props.onSourceUrlChange(e.target.value)}
                placeholder="/models/1HTQ.pdb or URL"
                className="w-full rounded-md bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 outline-none focus:ring-2 focus:ring-zinc-500"
            />
            {chains && chains.length > 0 && (
                <div className="mt-3">
                    <div className="my-2 h-px bg-zinc-800" />
                    <div className="mb-2 text-sm font-semibold">Chains</div>
                    <div className="max-h-40 space-y-2 overflow-y-auto pr-1">
                        {chains.map((c, idx) => (
                            <label key={idx} className="flex items-center gap-2 text-sm">
                                <input
                                    type="checkbox"
                                    className="h-4 w-4 rounded border-zinc-700 bg-zinc-900"
                                    checked={props.chainSelected[idx] !== false}
                                    onChange={(e) => props.onToggleChain(idx, e.target.checked)}
                                />
                                <span>{c.id || "(blank)"}</span>
                            </label>
                        ))}
                    </div>
                    <div className="flex gap-2 pt-3">
                        <button
                            onClick={props.onAllChains}
                            className="rounded-md border border-zinc-600 bg-zinc-700 px-3 py-1.5 text-xs text-zinc-100 hover:bg-zinc-600 focus:outline-none focus:ring-2 focus:ring-zinc-500 transition-colors"
                        >
                            All
                        </button>
                        <button
                            onClick={props.onNoChains}
                            className="rounded-md border border-zinc-600 bg-zinc-700 px-3 py-1.5 text-xs text-zinc-100 hover:bg-zinc-600 focus:outline-none focus:ring-2 focus:ring-zinc-500 transition-colors"
                        >
                            None
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
