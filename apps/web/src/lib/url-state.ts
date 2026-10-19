// Rapor filtreleri ve grafik türü seçimleri URL'de tutulur (paylaşılabilir bağlantı).
import { useCallback } from "react";
import { useSearchParams } from "react-router";

export function useUrlState<T extends string = string>(key: string, fallback: NoInfer<T>): [T, (v: T) => void] {
  const [params, setParams] = useSearchParams();
  const value = (params.get(key) as T | null) ?? fallback;
  const set = useCallback(
    (v: T) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (v === fallback) next.delete(key);
          else next.set(key, v);
          return next;
        },
        { replace: true },
      ),
    [key, fallback, setParams],
  );
  return [value, set];
}

/** localStorage'da kullanıcı tercihi (ör. son seçilen grafik türü); erişilemezse varsayılan. */
export function readPref(key: string): string | null {
  try {
    return localStorage.getItem(`vmes:${key}`);
  } catch {
    return null;
  }
}

export function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(`vmes:${key}`, value);
  } catch {
    /* yoksay */
  }
}
