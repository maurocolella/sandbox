/*
 Title: useMolScene
 Description: Fetches a structure (PDB or mmCIF, optionally gzipped) and parses it into a MolScene.
 mmCIF is parsed in a worker via cif-parser; PDB text uses pdb-parser. If the URL can't be fetched or
 parsed, an optional fallback URL is tried (PDB IDs: mmCIF first, legacy PDB second). Exposes
 { scene, error, loading } and re-runs when the URLs or key parse options change; the previous scene
 stays until the next is ready.
*/
import { useEffect, useRef, useState } from "react";
import type { MolScene, ParseOptions } from "pdb-parser";
import * as PDB from "pdb-parser";
import { MmcifWorkerClient } from "cif-parser";
import MmcifWorker from "cif-parser/worker?worker";

const isGzip = (b: Uint8Array) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;

class FetchError extends Error {
  readonly status: number;
  constructor(status: number, statusText: string) {
    super(`Failed to fetch structure: ${status} ${statusText}`);
    this.status = status;
  }
}

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

export function useMolScene(url: string, options: ParseOptions, fallbackUrl?: string): { scene: MolScene | null, error?: string, loading: boolean } {
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
    const load = async (from: string): Promise<MolScene> => {
      const res = await fetch(from);
      if (!res.ok) throw new FetchError(res.status, res.statusText);
      let bytes = new Uint8Array(await res.arrayBuffer());
      if (isGzip(bytes)) bytes = await gunzip(bytes);
      if (isCif(from, bytes)) {
        const client = cifClient.current;
        if (!client) throw new DOMException("unmounted", "AbortError");
        return client.load(bytes, {
          altLocPolicy: options.altLocPolicy,
          ...(options.modelSelection != null ? { modelSelection: options.modelSelection } : {}),
        });
      }
      const text = new TextDecoder().decode(bytes);
      try {
        return await PDB.parsePdbToMolSceneAsync(text, options);
      } catch {
        return PDB.parsePdbToMolScene(text, options);
      }
    };
    (async () => {
      try {
        let parsed: MolScene;
        try {
          parsed = await load(url);
        } catch (primary) {
          // A 404 means the entry doesn't exist (every entry has mmCIF), so the fallback would 404 too
          const missing = primary instanceof FetchError && primary.status === 404;
          if (!fallbackUrl || !mounted || missing || (primary instanceof DOMException && primary.name === "AbortError")) throw primary;
          try {
            parsed = await load(fallbackUrl);
          } catch {
            throw primary; // report the preferred source's failure
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
  }, [url, fallbackUrl, options.altLocPolicy, options.modelSelection, options.bondPolicy]);

  return { scene, error, loading };
}
