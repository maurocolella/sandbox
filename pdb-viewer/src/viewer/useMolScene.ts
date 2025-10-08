import { useEffect, useState } from "react";
import type { MolScene, ParseOptions } from "pdb-parser";
import { parsePdbToMolScene } from "pdb-parser";

export function useMolScene(url: string, options: ParseOptions): { scene: MolScene | null, error?: string, loading: boolean } {
  const [scene, setScene] = useState<MolScene | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(undefined);
    setScene(null);
    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Failed to fetch PDB: ${res.status} ${res.statusText}`);
        const text = await res.text();
        const parsed = parsePdbToMolScene(text, options);
        if (mounted) setScene(parsed);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (mounted) setError(msg);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  // We purposefully track the relevant fields instead of the options object identity.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, options.altLocPolicy, options.modelSelection, options.bondPolicy]);

  return { scene, error, loading };
}
