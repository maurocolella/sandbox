/*
 Title: useMolScene
 Description: Fetches a PDB file from a URL and parses it into a MolScene using pdb-parser.
 Exposes { scene, error, loading } and re-runs when the URL or key parse options change.
*/
import { useEffect, useState } from "react";
import type { MolScene, ParseOptions } from "pdb-parser";
import * as PDB from "pdb-parser";

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
        let parsed: MolScene;
        const maybe = PDB as unknown as { parsePdbToMolScene: (t: string, o: ParseOptions) => MolScene; parsePdbToMolSceneAsync?: (t: string, o: ParseOptions) => Promise<MolScene> };
        if (typeof maybe.parsePdbToMolSceneAsync === "function") {
          try {
            parsed = await maybe.parsePdbToMolSceneAsync(text, options);
          } catch {
            parsed = maybe.parsePdbToMolScene(text, options);
          }
        } else {
          parsed = maybe.parsePdbToMolScene(text, options);
        }
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
