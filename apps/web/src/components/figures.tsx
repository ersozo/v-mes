// Sayı biçimli göstergeler: KPI kartı (stat tile) ve ilerleme çubuğu (meter).
import type { ReactNode } from "react";
import { pct } from "../lib/format";
import { cn } from "./ui";

/** Değerin hedefe göre şiddeti: OEE için yaygın eşikler (≥ %85 dünya standardı, < %60 düşük). */
export function severity(value: number | null | undefined, good = 0.85, poor = 0.6): "good" | "warning" | "critical" | "none" {
  if (value === null || value === undefined) return "none";
  return value >= good ? "good" : value >= poor ? "warning" : "critical";
}

const SEVERITY_FILL = { good: "var(--status-good)", warning: "var(--status-warning)", critical: "var(--status-critical)", none: "var(--axis)", accent: "var(--accent)" };

export function Meter({ value, label, tone }: { value: number | null | undefined; label: string; tone?: ReturnType<typeof severity> | "accent" }) {
  const s = tone ?? severity(value);
  const w = value === null || value === undefined ? 0 : Math.max(0, Math.min(1, value));
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value === null || value === undefined ? undefined : Math.round(value * 100)}
      className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2"
    >
      <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${w * 100}%`, background: SEVERITY_FILL[s] }} />
    </div>
  );
}

export function StatTile({
  label,
  value,
  sub,
  meter,
  hero,
  className,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  meter?: number | null;
  hero?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2 rounded-xl border border-line bg-surface p-4", className)}>
      <span className="text-[13px] text-ink-2">{label}</span>
      <span className={cn("font-semibold tracking-tight", hero ? "text-5xl" : "text-[28px] leading-none")}>{value}</span>
      {meter !== undefined && <Meter value={meter} label={label} />}
      {sub && <span className="text-[12px] text-muted">{sub}</span>}
    </div>
  );
}

export function OeeTiles({ m, hero = true }: { m: { availability: number | null; performance: number | null; quality: number | null; oee: number | null } | undefined; hero?: boolean }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatTile hero={hero} label="OEE" value={pct(m?.oee)} meter={m?.oee ?? null} sub="Kullanılabilirlik × Performans × Kalite" />
      <StatTile label="Kullanılabilirlik" value={pct(m?.availability)} meter={m?.availability ?? null} sub="Çalışma / planlı süre" />
      <StatTile label="Performans" value={pct(m?.performance)} meter={m?.performance ?? null} sub="İdeal hız / gerçek hız" />
      <StatTile label="Kalite" value={pct(m?.quality)} meter={m?.quality ?? null} sub="İyi / toplam adet" />
    </div>
  );
}
