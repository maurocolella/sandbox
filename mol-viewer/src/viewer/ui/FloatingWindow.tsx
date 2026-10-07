/*
 Title: FloatingWindow
 Description: Frosted window floating over the canvas: dragged by its title bar, brought to front on click,
 closable, optionally resettable and resizable (bottom-right corner); position and size are remembered
 per id. The window stays within the viewport; its content scrolls when it doesn't fit.
*/
import { useRef, useState, type ReactNode } from "react";
import { usePersistentState } from "../../lib/hooks/usePersistentState";
import { FROST } from "./frost";

let topZ = 30;
const MIN_WIDTH = 220, MIN_HEIGHT = 120, MARGIN = 12;

export interface FloatingWindowProps {
  id: string;
  title: string;
  width: number;
  defaultPosition: { x: number; y: number };
  onClose: () => void;
  /** Shows a reset button (restore defaults). */
  onReset?: () => void;
  /** Adds a resize grip in the bottom-right corner. */
  resizable?: boolean;
  children: ReactNode;
}

export function FloatingWindow({ id, title, width, defaultPosition, onClose, onReset, resizable, children }: FloatingWindowProps) {
  const [pos, setPos] = usePersistentState(`mol-viewer:window:${id}`, defaultPosition);
  // height 0: fit the content
  const [size, setSize] = usePersistentState(`mol-viewer:window-size:${id}`, { width, height: 0 });
  const [z, setZ] = useState(() => ++topZ);
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const resize = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  // Keep at least the title bar reachable when the browser window is resized smaller
  const x = Math.min(Math.max(0, pos.x), Math.max(0, window.innerWidth - 80));
  const y = Math.min(Math.max(0, pos.y), Math.max(0, window.innerHeight - 40));
  const w = resizable ? size.width : width;

  return (
    <div
      ref={box}
      className={`fixed flex flex-col rounded-lg ${FROST}`}
      style={{ left: x, top: y, width: w, height: resizable && size.height ? size.height : undefined, maxHeight: window.innerHeight - y - MARGIN, zIndex: z }}
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
        <span className="flex-1 truncate">{title}</span>
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
      <div className="min-h-0 flex-1 overflow-auto p-2">{children}</div>
      {resizable && (
        <div
          className="absolute right-0 bottom-0 h-3.5 w-3.5 cursor-nwse-resize"
          style={{ background: "linear-gradient(135deg, transparent 50%, var(--ui-muted) 50%, var(--ui-muted) 60%, transparent 60%, transparent 75%, var(--ui-muted) 75%, var(--ui-muted) 85%, transparent 85%)" }}
          title="Resize"
          onPointerDown={(e) => {
            e.stopPropagation();
            const r = box.current!.getBoundingClientRect();
            resize.current = { x: e.clientX, y: e.clientY, width: r.width, height: r.height };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const r = resize.current;
            if (!r) return;
            setSize({
              width: Math.min(window.innerWidth - x - MARGIN, Math.max(MIN_WIDTH, r.width + e.clientX - r.x)),
              height: Math.min(window.innerHeight - y - MARGIN, Math.max(MIN_HEIGHT, r.height + e.clientY - r.y)),
            });
          }}
          onPointerUp={() => { resize.current = null; }}
        />
      )}
    </div>
  );
}
