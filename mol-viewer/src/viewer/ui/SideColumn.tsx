/*
 Title: SideColumn
 Description: PyMOL-style object column floating over the canvas below the top bar: the loaded object and
 its chains, plus the everyday display toggles. Resizable by its inner edge, switchable between the left and
 right side, collapsible; the layout is remembered.
*/
import { useRef, type ReactNode } from "react";
import { usePersistentState } from "../../lib/hooks/usePersistentState";
import { FROST } from "./frost";

export type Representation = "spheres" | "ribbon-tube" | "ribbon-flat";
export type SelectionMode = "none" | "atom" | "residue" | "chain";

export interface SideColumnProps {
  objectName?: string;
  chains: { index: number; id: string }[];
  chainSelected: Record<number, boolean>;
  onToggleChain: (idx: number, visible: boolean) => void;
  onAllChains: () => void;
  onNoChains: () => void;
  selectionMode: SelectionMode;
  onSelectionMode: (m: SelectionMode) => void;
  representation: Representation;
  onRepresentation: (r: Representation) => void;
  show: { atoms: boolean; bonds: boolean; backbone: boolean };
  onShow: (key: "atoms" | "bonds" | "backbone", value: boolean) => void;
  surface: boolean;
  onSurface: (on: boolean) => void;
}

const MIN_WIDTH = 200, MAX_WIDTH = 480;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-white/10 px-3 py-2.5 first:border-t-0">
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">{title}</div>
      {children}
    </section>
  );
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex rounded-md bg-white/5 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`flex-1 rounded px-1.5 py-1 text-xs transition-colors ${value === o.value ? "bg-white/15 text-zinc-50" : "text-zinc-300 hover:bg-white/10"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className={`flex items-center justify-between py-0.5 text-sm ${disabled ? "opacity-40" : ""}`}>
      <span>{label}</span>
      <input type="checkbox" className="h-4 w-4 accent-zinc-300" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

const IconButton = ({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) => (
  <button onClick={onClick} title={label} aria-label={label} className="rounded px-1.5 py-0.5 text-zinc-300 hover:bg-white/10 hover:text-zinc-50">
    {children}
  </button>
);

export function SideColumn(props: SideColumnProps) {
  const [layout, setLayout] = usePersistentState("mol-viewer:column", { side: "right" as "left" | "right", width: 260, collapsed: false });
  const resize = useRef<{ x: number; width: number } | null>(null);
  const right = layout.side === "right";
  const allVisible = props.chains.length > 0 && props.chains.every((c) => props.chainSelected[c.index] !== false);

  const header = (
    <div className={`flex items-center gap-1 px-2 py-1.5 ${layout.collapsed ? "flex-col" : right ? "" : "flex-row-reverse"}`}>
      <IconButton label={layout.collapsed ? "Expand" : "Collapse"} onClick={() => setLayout({ ...layout, collapsed: !layout.collapsed })}>
        {/* Points toward the edge it collapses to, or away from it when collapsed */}
        {(right !== layout.collapsed) ? "▸" : "◂"}
      </IconButton>
      <IconButton label={right ? "Move to the left" : "Move to the right"} onClick={() => setLayout({ ...layout, side: right ? "left" : "right" })}>⇄</IconButton>
      {!layout.collapsed && <span className="mx-1 flex-1 text-xs font-semibold tracking-wide text-zinc-300">{props.objectName ?? "No object"}</span>}
    </div>
  );

  return (
    <aside
      className={`fixed top-[68px] bottom-3 z-10 flex flex-col rounded-lg ${FROST} ${right ? "right-3" : "left-3"}`}
      style={{ width: layout.collapsed ? undefined : layout.width }}
    >
      {header}
      {!layout.collapsed && (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto border-t border-white/10">
            <Section title="Objects">
              {props.chains.length === 0 ? (
                <div className="text-xs text-zinc-500">Nothing loaded</div>
              ) : (
                <>
                  <label className="flex items-center justify-between text-sm">
                    <span className="truncate font-medium">{props.objectName ?? "structure"}</span>
                    <input type="checkbox" className="h-4 w-4 accent-zinc-300" checked={allVisible} onChange={(e) => (e.target.checked ? props.onAllChains() : props.onNoChains())} />
                  </label>
                  <div className="mb-1.5" />
                  <div className="flex max-h-48 flex-wrap gap-1 overflow-y-auto">
                    {props.chains.map((c) => {
                      const on = props.chainSelected[c.index] !== false;
                      return (
                        <button
                          key={c.index}
                          onClick={() => props.onToggleChain(c.index, !on)}
                          className={`min-w-7 rounded px-1.5 py-0.5 font-mono text-xs transition-colors ${on ? "bg-white/15 text-zinc-50" : "bg-white/5 text-zinc-500 hover:text-zinc-300"}`}
                          title={`Chain ${c.id || "(blank)"}`}
                        >
                          {c.id || "·"}
                        </button>
                      );
                    })}
                  </div>
                  <div className="mt-2 flex gap-1">
                    <button onClick={props.onAllChains} className="rounded px-2 py-0.5 text-xs text-zinc-300 hover:bg-white/10">All</button>
                    <button onClick={props.onNoChains} className="rounded px-2 py-0.5 text-xs text-zinc-300 hover:bg-white/10">None</button>
                  </div>
                </>
              )}
            </Section>
            <Section title="Select">
              <Segmented
                value={props.selectionMode}
                onChange={props.onSelectionMode}
                options={[{ value: "atom", label: "Atom" }, { value: "residue", label: "Residue" }, { value: "chain", label: "Chain" }, { value: "none", label: "None" }]}
              />
            </Section>
            <Section title="Representation">
              <Segmented
                value={props.representation}
                onChange={props.onRepresentation}
                options={[{ value: "spheres", label: "Spheres" }, { value: "ribbon-tube", label: "Tube" }, { value: "ribbon-flat", label: "Flat" }]}
              />
              <div className="mt-2">
                <Toggle label="Atoms" checked={props.show.atoms} disabled={props.representation !== "spheres"} onChange={(v) => props.onShow("atoms", v)} />
                <Toggle label="Bonds" checked={props.show.bonds} onChange={(v) => props.onShow("bonds", v)} />
                <Toggle label="Backbone" checked={props.show.backbone} disabled={props.representation !== "spheres"} onChange={(v) => props.onShow("backbone", v)} />
              </div>
            </Section>
            <Section title="Surface">
              <Toggle label="Show surface" checked={props.surface} onChange={props.onSurface} />
            </Section>
          </div>
          {/* Inner edge: drag to resize */}
          <div
            className={`absolute top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-white/20 ${right ? "-left-0.5" : "-right-0.5"} rounded`}
            onPointerDown={(e) => { resize.current = { x: e.clientX, width: layout.width }; e.currentTarget.setPointerCapture(e.pointerId); }}
            onPointerMove={(e) => {
              if (!resize.current) return;
              const delta = (e.clientX - resize.current.x) * (right ? -1 : 1);
              setLayout({ ...layout, width: Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, resize.current.width + delta)) });
            }}
            onPointerUp={() => { resize.current = null; }}
          />
        </>
      )}
    </aside>
  );
}
