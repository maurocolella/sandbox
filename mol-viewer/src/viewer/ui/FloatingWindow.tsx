/*
 Title: FloatingWindow
 Description: Frosted window floating over the canvas: dragged by its title bar, brought to front on click,
 closable, optionally resettable; its position is remembered per id.
*/
import { useRef, useState, type ReactNode } from "react";
import { usePersistentState } from "../../lib/hooks/usePersistentState";
import { FROST } from "./frost";

let topZ = 30;

export interface FloatingWindowProps {
  id: string;
  title: string;
  width: number;
  defaultPosition: { x: number; y: number };
  onClose: () => void;
  /** Shows a reset button (restore defaults). */
  onReset?: () => void;
  children: ReactNode;
}

export function FloatingWindow({ id, title, width, defaultPosition, onClose, onReset, children }: FloatingWindowProps) {
  const [pos, setPos] = usePersistentState(`mol-viewer:window:${id}`, defaultPosition);
  const [z, setZ] = useState(() => ++topZ);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  // Keep at least the title bar reachable when the window is resized smaller
  const x = Math.min(Math.max(0, pos.x), Math.max(0, window.innerWidth - 80));
  const y = Math.min(Math.max(0, pos.y), Math.max(0, window.innerHeight - 40));

  return (
    <div
      className={`fixed rounded-lg ${FROST}`}
      style={{ left: x, top: y, width, zIndex: z }}
      onPointerDown={() => setZ(++topZ)}
    >
      <div
        className="flex cursor-move select-none items-center justify-between border-b border-(--ui-border) px-3 py-1.5 text-xs font-semibold tracking-wide text-(--ui-fg)"
        onPointerDown={(e) => {
          drag.current = { dx: e.clientX - x, dy: e.clientY - y };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => { if (drag.current) setPos({ x: e.clientX - drag.current.dx, y: e.clientY - drag.current.dy }); }}
        onPointerUp={() => { drag.current = null; }}
      >
        <span className="flex-1">{title}</span>
        {onReset && (
          <button
            className="rounded px-1 text-(--ui-muted) hover:bg-(--ui-hover) hover:text-(--ui-strong)"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onReset}
            title="Reset to defaults"
            aria-label={`Reset ${title} to defaults`}
          >
            ↺
          </button>
        )}
        <button
          className="-mr-1 rounded px-1 text-(--ui-muted) hover:bg-(--ui-hover) hover:text-(--ui-strong)"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onClose}
          aria-label={`Close ${title}`}
        >
          ✕
        </button>
      </div>
      <div className="p-2">{children}</div>
    </div>
  );
}
