import { useEffect, useState } from "react";

export type ThemePref = "system" | "light" | "dark";

function read(): ThemePref {
  try {
    const t = localStorage.getItem("vmes-theme");
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

export function useTheme(): [ThemePref, (t: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>(read);
  useEffect(() => {
    const root = document.documentElement;
    if (pref === "system") delete root.dataset.theme;
    else root.dataset.theme = pref;
    try {
      if (pref === "system") localStorage.removeItem("vmes-theme");
      else localStorage.setItem("vmes-theme", pref);
    } catch {
      /* depolama kapalı */
    }
  }, [pref]);
  return [pref, setPref];
}

/** CSS değişkeninin o anki değeri (Recharts gibi SVG kütüphanelerine renk vermek için). */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Tema değişince yeniden çizim tetiklemek için. */
export function useThemeVersion(): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    const bump = () => setV((x) => x + 1);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", bump);
    const obs = new MutationObserver(bump);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      mq.removeEventListener("change", bump);
      obs.disconnect();
    };
  }, []);
  return v;
}
