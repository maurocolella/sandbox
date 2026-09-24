/*
 Title: RenderStats
 Description: Reports what the last frame drew (triangles, counting instanced copies, and draw calls). Reads
 renderer.info after each render via the scene's onAfterRender, since the canvas renders on demand. Reports
 go to React, so they are throttled (at most every 250 ms, trailing) and only sent when the numbers change.
*/
import { useEffect } from "react";
import { useThree } from "@react-three/fiber";

export interface RenderStatsInfo {
  triangles: number;
  drawCalls: number;
}

export function RenderStats({ onStats }: { onStats: (s: RenderStatsInfo) => void }) {
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    let sent = { triangles: -1, drawCalls: -1 };
    let latest = sent;
    let timer: number | null = null;
    const flush = () => {
      timer = null;
      if (latest.triangles !== sent.triangles || latest.drawCalls !== sent.drawCalls) { sent = latest; onStats(sent); }
    };
    const previous = scene.onAfterRender;
    scene.onAfterRender = (renderer, ...rest) => {
      previous.call(scene, renderer, ...rest);
      const { triangles, calls } = renderer.info.render;
      if (triangles !== latest.triangles || calls !== latest.drawCalls) latest = { triangles, drawCalls: calls };
      if (timer === null) timer = window.setTimeout(flush, 250);
    };
    return () => { scene.onAfterRender = previous; if (timer !== null) clearTimeout(timer); };
  }, [scene, onStats]);
  return null;
}
