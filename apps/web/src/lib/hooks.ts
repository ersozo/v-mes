import { useEffect, useState } from "react";

/** Her `ms` milisaniyede bir yeniden çizim (canlı süre sayaçları için). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
