/*
 Title: useMolScene
 Description: Fetches a structure (PDB or mmCIF, optionally gzipped) and parses it into a MolScene.
 mmCIF is parsed in a worker via cif-parser; PDB text uses pdb-parser. Exposes { scene, error, loading }
 and re-runs when the URL or key parse options change; the previous scene stays until the next is ready.
*/
import { useEffect, useRef, useState } from "react";
import type { MolScene, ParseOptions } from "pdb-parser";
import * as PDB from "pdb-parser";
import { MmcifWorkerClient } from "cif-parser";
import MmcifWorker from "cif-parser/worker?worker";

const isGzip = (b: Uint8Array) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** mmCIF by extension, or by content: the first token that isn't a comment starts with data_. */
function isCif(url: string, bytes: Uint8Array): boolean {
  const path = url.split(/[?#]/)[0]!.toLowerCase();
  if (/\.(cif|mmcif)(\.gz)?$/.test(path)) return true;
  if (/\.(pdb|ent)(\.gz)?$/.test(path)) return false;
  const head = new TextDecoder().decode(bytes.subarray(0, 4096));
  for (const line of head.split(/\r?\n|\r/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    return t.toLowerCase().startsWith("data_");
  }
  return false;
}

export function useMolScene(url: string, options: ParseOptions): { scene: MolScene | null, error?: string, loading: boolean } {
  const [scene, setScene] = useState<MolScene | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState<boolean>(true);
  const cifClient = useRef<MmcifWorkerClient | null>(null);

  useEffect(() => {
    const client = new MmcifWorkerClient(() => new MmcifWorker());
    cifClient.current = client;
    return () => { client.dispose(); cifClient.current = null; };
  }, []);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(undefined);
    // Keep the current scene on screen until the new one has parsed
    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Failed to fetch structure: ${res.status} ${res.statusText}`);
        let bytes = new Uint8Array(await res.arrayBuffer());
        if (isGzip(bytes)) bytes = await gunzip(bytes);
        let parsed: MolScene;
        if (isCif(url, bytes)) {
          const client = cifClient.current;
          if (!client) return;
          parsed = await client.load(bytes, {
            altLocPolicy: options.altLocPolicy,
            ...(options.modelSelection != null ? { modelSelection: options.modelSelection } : {}),
          });
        } else {
          const text = new TextDecoder().decode(bytes);
          try {
            parsed = await PDB.parsePdbToMolSceneAsync(text, options);
          } catch {
            parsed = PDB.parsePdbToMolScene(text, options);
          }
        }
        if (mounted) setScene(parsed);
      } catch (e: unknown) {
        if (e instanceof DOMException && e.name === "AbortError") return; // superseded by a newer load
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
