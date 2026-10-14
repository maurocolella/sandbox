/*
 Title: RenderSettings
 Description: Advanced path-traced render settings: how far the context recedes around the selected ligand,
 depth of field, and depth fog.
*/
import type { RenderSettings as Settings } from "../../lib/hooks/useRendererControls";

function Slider({ label, hint, value, onChange }: { label: string; hint: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="block py-1" title={hint}>
      <div className="flex justify-between text-sm"><span>{label}</span><span className="font-mono text-xs text-(--ui-muted)">{value.toFixed(2)}</span></div>
      <input type="range" min={0} max={1} step={0.05} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-(--ui-fg)" />
    </label>
  );
}

export function RenderSettings({ value, onChange }: { value: Settings; onChange: (v: Settings) => void }) {
  return (
    <div className="text-(--ui-fg)">
      <Slider label="Ligand focus" hint="With a ligand selected, how much the rest of the structure fades" value={value.ligandFocus} onChange={(ligandFocus) => onChange({ ...value, ligandFocus })} />
      <Slider label="Depth of field" hint="Blur away from the selected ligand (or the view's centre)" value={value.depthOfField} onChange={(depthOfField) => onChange({ ...value, depthOfField })} />
      <Slider label="Depth fog" hint="Fade toward the background with distance" value={value.fog} onChange={(fog) => onChange({ ...value, fog })} />
    </div>
  );
}
