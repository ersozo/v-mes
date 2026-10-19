// Ortak grafik ayarları (veri görselleştirme rehberi: ince işaretler, silik ızgara, tek eksen).
import type { ReactNode } from "react";

/** Kategorik sıra sabittir (renk körlüğüne göre doğrulanmış); seri rengini sıra değil varlık belirler. */
export const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)", "var(--series-5)", "var(--series-6)", "var(--series-7)", "var(--series-8)"];

export const METRIC_COLORS = {
  oee: "var(--series-1)",
  availability: "var(--series-2)",
  performance: "var(--series-3)",
  quality: "var(--series-4)",
} as const;

export const METRIC_LABELS = { oee: "OEE", availability: "Kullanılabilirlik", performance: "Performans", quality: "Kalite" } as const;

export const axisProps = {
  stroke: "var(--axis)",
  tick: { fill: "var(--muted)", fontSize: 12 },
  tickLine: false,
  axisLine: { stroke: "var(--axis)" },
} as const;

export const gridProps = { stroke: "var(--grid)", strokeDasharray: undefined, vertical: false } as const;

export const pctTick = (v: number) => `%${Math.round(v * 100)}`;

export const BAR_MAX = 24;

/** Tema uyumlu tooltip kutusu. */
export function TooltipBox({ title, rows }: { title?: ReactNode; rows: { color?: string; label: ReactNode; value: ReactNode }[] }) {
  return (
    <div className="min-w-40 rounded-lg border border-line bg-surface px-3 py-2 text-[12px] shadow-lg">
      {title && <div className="mb-1 font-medium text-ink">{title}</div>}
      {rows.map((r, i) => (
        <div key={i} className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5 text-ink-2">
            {r.color && <span className="inline-block size-2 rounded-full" style={{ background: r.color }} aria-hidden />}
            {r.label}
          </span>
          <span className="tabular font-medium text-ink">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

/** Lejant: renkli işaret + metin rengi (metin hiçbir zaman seri renginde değildir). */
export function Legend({ items }: { items: { color: string; label: string; shape?: "dot" | "line" | "square" }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-2" aria-label="Lejant">
      {items.map((it) => (
        <li key={it.label} className="flex items-center gap-1.5">
          {it.shape === "line" ? (
            <span className="inline-block h-0.5 w-3 rounded" style={{ background: it.color }} aria-hidden />
          ) : (
            <span className={it.shape === "square" ? "inline-block size-2.5 rounded-sm" : "inline-block size-2 rounded-full"} style={{ background: it.color }} aria-hidden />
          )}
          {it.label}
        </li>
      ))}
    </ul>
  );
}
