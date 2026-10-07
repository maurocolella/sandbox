/*
 Title: TopBar
 Description: Frosted bar across the top of the canvas: the structure source field, the loaded entry's
 title (ellipsised, in full on hover) and the menu toggles that open the floating windows.
*/
import { FROST } from "./frost";

export interface TopBarMenu { id: string; label: string; open: boolean }

export interface TopBarProps {
  sourceInput: string;
  onSourceInputChange: (value: string) => void;
  hint?: string;
  error?: string;
  /** Shown instead of the hint once the entry has loaded. */
  title?: string;
  menus: TopBarMenu[];
  onToggleMenu: (id: string) => void;
}

export function TopBar(props: TopBarProps) {
  return (
    <div className={`fixed top-3 left-3 right-3 z-20 flex h-11 items-center gap-3 rounded-lg px-2 ${FROST}`}>
      <input
        type="text"
        value={props.sourceInput}
        onChange={(e) => props.onSourceInputChange(e.target.value)}
        placeholder="PDB ID (e.g. 4HHB), URL or path"
        spellCheck={false}
        className="w-64 rounded-md bg-white/5 px-3 py-1.5 text-sm text-zinc-100 placeholder-zinc-500 outline-none focus:ring-1 focus:ring-white/30"
      />
      {props.error
        ? <span className="min-w-0 truncate text-xs text-red-400" title={props.error}>{props.error}</span>
        : props.title
          ? <span className="min-w-0 truncate text-sm text-zinc-200" title={props.title}>{props.title}</span>
          : <span className="min-w-0 truncate text-xs text-zinc-400">{props.hint}</span>}
      <nav className="ml-auto flex gap-1">
        {props.menus.map((m) => (
          <button
            key={m.id}
            onClick={() => props.onToggleMenu(m.id)}
            className={`rounded-md px-2.5 py-1 text-xs transition-colors ${m.open ? "bg-white/15 text-zinc-50" : "text-zinc-300 hover:bg-white/10"}`}
            aria-pressed={m.open}
          >
            {m.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
