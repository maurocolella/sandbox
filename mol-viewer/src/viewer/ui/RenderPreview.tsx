/*
 Title: RenderPreview
 Description: A path-traced render in progress or done: the image so far (the render's own canvas, scaled
 down), samples and time, and Cancel; once done, Inspect (the PNG in a new tab) and Download.
*/
import { useEffect, useRef, useState } from "react";
import type { PathTraceProgress } from "mol-renderer";

const seconds = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
const button = "rounded-md bg-(--ui-input) px-2.5 py-1 text-xs text-(--ui-strong) transition-colors hover:bg-(--ui-hover)";

export function RenderPreview({ progress, onCancel, fileName }: { progress: PathTraceProgress; onCancel: () => void; fileName: string }) {
  const holder = useRef<HTMLDivElement>(null);
  const { canvas, stage, samples, total, elapsed, omitted } = progress;
  const done = stage === "done";
  // The finished PNG, made once so Inspect can open it within the click (popup blockers)
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!done) return;
    let objectUrl: string | null = null, live = true;
    canvas.toBlob((blob) => {
      if (!blob || !live) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    }, "image/png");
    return () => { live = false; if (objectUrl) URL.revokeObjectURL(objectUrl); setUrl(null); };
  }, [done, canvas]);

  // The render's canvas, shown in place and scaled to the window
  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    canvas.style.width = "100%";
    canvas.style.height = "auto";
    canvas.style.display = "block";
    el.replaceChildren(canvas);
  }, [canvas]);

  const download = () => {
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
  };
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
              <button className={button} disabled={!url} onClick={() => url && window.open(url, "_blank")}>Inspect</button>
              <button className={button} disabled={!url} onClick={download}>Download</button>
            </>
          ) : <button className={button} onClick={onCancel}>Cancel</button>}
        </span>
      </div>
      {omitted.length > 0 && <div className="text-amber-500">Left out to fit the render budget: {omitted.join(", ")}.</div>}
    </div>
  );
}
