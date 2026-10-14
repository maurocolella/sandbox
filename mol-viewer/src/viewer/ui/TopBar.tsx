/*
 Title: TopBar
 Description: Frosted bar across the top of the canvas: the structure source field, the loaded entry's
 title (ellipsised, in full on hover), the menu toggles that open the floating windows, and the light/dark
 theme toggle.
*/
import { Moon, Sun } from "lucide-react";
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
  theme: "light" | "dark";
  onToggleTheme: () => void;
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
        className="w-64 rounded-md bg-(--ui-input) px-3 py-1.5 text-sm text-(--ui-strong) placeholder-(--ui-muted) outline-none focus:ring-1 focus:ring-(--ui-active)"
      />
      {props.error
        ? <span className="min-w-0 truncate text-xs text-red-400" title={props.error}>{props.error}</span>
        : props.title
          ? <span className="min-w-0 truncate text-sm text-(--ui-fg)" title={props.title}>{props.title}</span>
          : <span className="min-w-0 truncate text-xs text-(--ui-muted)">{props.hint}</span>}
      <nav className="ml-auto flex gap-1">
        {props.menus.map((m) => (
          <button
            key={m.id}
            onClick={() => props.onToggleMenu(m.id)}
            className={`rounded-md px-2.5 py-1 text-xs transition-colors ${m.open ? "bg-(--ui-active) text-(--ui-strong)" : "text-(--ui-fg) hover:bg-(--ui-hover)"}`}
            aria-pressed={m.open}
          >
            {m.label}
          </button>
        ))}
        <span className="mx-1 w-px self-stretch bg-(--ui-border)" />
        <button
          onClick={props.onToggleTheme}
          className="rounded-md px-2 py-1 text-(--ui-fg) transition-colors hover:bg-(--ui-hover)"
          title={props.theme === "dark" ? "Light theme" : "Dark theme"}
          aria-label={props.theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
        >
          {props.theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
        </button>
      </nav>
    </div>
  );
}
