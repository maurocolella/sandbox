/*
 Title: useTheme
 Description: Light or dark UI theme: follows the OS setting until the user picks one (remembered). Applies
 the `dark` class and color-scheme to the document.
*/
import { useEffect, useState } from "react";
import { usePersistentState } from "./usePersistentState";

export type Theme = "light" | "dark";

const query = () => window.matchMedia?.("(prefers-color-scheme: dark)");

export function useTheme(): { theme: Theme; toggle: () => void } {
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
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
    root.style.colorScheme = theme;
  }, [theme]);
  return { theme, toggle: () => setChosen(theme === "dark" ? "light" : "dark") };
}
