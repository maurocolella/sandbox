/*
 Title: usePersistentState
 Description: useState mirrored to localStorage (UI layout only; works without storage, e.g. private windows).
*/
import { useEffect, useState } from "react";

export function usePersistentState<T>(key: string, initial: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return initial;
      const stored = JSON.parse(raw) as T;
      // Objects merge over the defaults, so fields added later get their default
      return initial && typeof initial === "object" && !Array.isArray(initial) ? { ...initial, ...stored } : stored;
    } catch { return initial; }
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  }, [key, value]);
  return [value, setValue];
}
