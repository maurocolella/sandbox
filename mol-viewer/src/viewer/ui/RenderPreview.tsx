/*
 Title: RenderPreview
 Description: A path-traced render in progress or done: the image so far (the render's own canvas, scaled
 down), samples and time, and Cancel; once done, Inspect (full size in an overlay: fit or 1:1, scrollable;
 Escape or a click outside closes it) and Download (PNG).
*/
import { useEffect, useRef, useState } from "react";
import type { PathTraceProgress } from "mol-renderer";

const seconds = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
const button = "rounded-md bg-(--ui-input) px-2.5 py-1 text-xs text-(--ui-strong) transition-colors hover:bg-(--ui-hover)";

function Inspector({ canvas, onClose }: { canvas: HTMLCanvasElement; onClose: () => void }) {
  const [actual, setActual] = useState(false);
  const url = useRef(canvas.toDataURL("image/png"));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/85" onClick={onClose}>
      <div className="flex items-center gap-3 px-4 py-2 text-xs text-zinc-200" onClick={(e) => e.stopPropagation()}>
        <span>{canvas.width} × {canvas.height} px</span>
        <button className="rounded-md bg-white/10 px-2.5 py-1 hover:bg-white/20" onClick={() => setActual((a) => !a)}>{actual ? "Fit to window" : "Actual size"}</button>
        <span className="ml-auto text-zinc-400">Esc to close</span>
      </div>
      <div className={`min-h-0 flex-1 ${actual ? "overflow-auto" : "flex items-center justify-center overflow-hidden p-4"}`}>
        <img
          src={url.current}
          alt="Path-traced render"
          onClick={(e) => { e.stopPropagation(); setActual((a) => !a); }}
          className={actual ? "max-w-none cursor-zoom-out" : "max-h-full max-w-full cursor-zoom-in object-contain"}
        />
      </div>
    </div>
  );
}

export function RenderPreview({ progress, onCancel, fileName }: { progress: PathTraceProgress; onCancel: () => void; fileName: string }) {
  const holder = useRef<HTMLDivElement>(null);
  const [inspecting, setInspecting] = useState(false);
  const { canvas, stage, samples, total, elapsed, omitted } = progress;

  // The render's canvas, shown in place and scaled to the window
  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    canvas.style.width = "100%";
    canvas.style.height = "auto";
    canvas.style.display = "block";
    el.replaceChildren(canvas);
  }, [canvas]);

  const download = () => canvas.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }, "image/png");

  const done = stage === "done";
  return (
    <div className="space-y-2 text-xs">
      <div ref={holder} className="overflow-hidden rounded-md bg-(--ui-input)" style={{ aspectRatio: `${canvas.width} / ${canvas.height}` }} />
      <div className="h-1 overflow-hidden rounded bg-(--ui-input)">
        <div className="h-full bg-(--ui-active) transition-[width]" style={{ width: `${Math.min(100, (samples / total) * 100)}%` }} />
      </div>
      <div className="flex items-center gap-2 text-(--ui-muted)">
        <span>
          {stage === "preparing" ? "Preparing scene…" : `${samples} / ${total} samples · ${seconds(elapsed)}`} · {canvas.width} × {canvas.height}
        </span>
        <span className="ml-auto flex gap-1.5">
          {done ? (
            <>
              <button className={button} onClick={() => setInspecting(true)}>Inspect</button>
              <button className={button} onClick={download}>Download</button>
            </>
          ) : <button className={button} onClick={onCancel}>Cancel</button>}
        </span>
      </div>
      {omitted.length > 0 && <div className="text-amber-500">Left out to fit the render budget: {omitted.join(", ")}.</div>}
      {inspecting && <Inspector canvas={canvas} onClose={() => setInspecting(false)} />}
    </div>
  );
}
