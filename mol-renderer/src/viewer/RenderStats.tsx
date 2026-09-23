/*
 Title: RenderStats
 Description: Reports what the last frame drew (triangles, counting instanced copies, and draw calls). Reads
 renderer.info after each render via the scene's onAfterRender, since the canvas renders on demand, and
 only reports when the numbers change.
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
    let last = { triangles: -1, drawCalls: -1 };
    const previous = scene.onAfterRender;
    scene.onAfterRender = (renderer, ...rest) => {
      previous.call(scene, renderer, ...rest);
      const { triangles, calls } = renderer.info.render;
      if (triangles !== last.triangles || calls !== last.drawCalls) {
        last = { triangles, drawCalls: calls };
        onStats(last);
      }
    };
    return () => { scene.onAfterRender = previous; };
  }, [scene, onStats]);
  return null;
}
