/*
 Title: useTheme
 Description: Light or dark UI theme: follows the OS setting until the user picks one (remembered). Applies
 the `dark` class and color-scheme to the document. Toggling crossfades the whole page (canvas included)
 with a view transition where supported, unless the user prefers reduced motion.
*/
import { useEffect, useLayoutEffect, useState } from "react";
import { flushSync } from "react-dom";
import { usePersistentState } from "./usePersistentState";

export type Theme = "light" | "dark";

const query = () => window.matchMedia?.("(prefers-color-scheme: dark)");
const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function useTheme(): { theme: Theme; toggle: (alongside?: (next: Theme) => void) => void } {
  const [system, setSystem] = useState<Theme>(() => (query()?.matches ? "dark" : "light"));
  const [chosen, setChosen] = usePersistentState<Theme | null>("mol-viewer:theme", null);
  useEffect(() => {
    const mq = query();
    if (!mq) return;
    const onChange = () => setSystem(mq.matches ? "dark" : "light");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const theme = chosen ?? system;
  // Layout effect: applied within the same synchronous update as the toggle, so a view transition's
  // "after" snapshot already has it
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
    root.style.colorScheme = theme;
  }, [theme]);

  /** Switch theme; `alongside` runs in the same update (e.g. the canvas background). */
  const toggle = (alongside?: (next: Theme) => void) => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    const update = () => flushSync(() => { setChosen(next); alongside?.(next); });
    if (!document.startViewTransition || reducedMotion()) { update(); return; }
    document.startViewTransition(update);
  };
  return { theme, toggle };
}
