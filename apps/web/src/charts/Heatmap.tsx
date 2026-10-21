import { Grid3x3 } from "lucide-react";
import { Fragment, useState } from "react";
import type { ChartType } from "../components/ChartCard";
import { Table } from "../components/ui";
import { num, pct } from "../lib/format";
import type { SeriesPoint } from "../lib/types";
import { TooltipBox } from "./common";

export type HeatmapType = "heatmap";
export const HEATMAP_TYPES: ChartType<HeatmapType>[] = [
  { value: "heatmap", label: "Isı haritası", icon: <Grid3x3 className="size-3.5" /> },
];

/** Sıralı tek ton (mavi) rampa; açık = düşük OEE. Yedi sınıf, %0–100 eşit aralıklı. */
const RAMP = ["var(--seq-100)", "var(--seq-200)", "var(--seq-300)", "var(--seq-400)", "var(--seq-500)", "var(--seq-600)", "var(--seq-700)"];
const color = (v: number) => RAMP[Math.min(RAMP.length - 1, Math.floor(Math.max(0, Math.min(0.9999, v)) * RAMP.length))]!;
const inkOn = (v: number) => (v >= 3 / 7 ? "#ffffff" : "#0b0b0b");

function colLabel(label: string) {
  const m = /(\d{2}):00$/.exec(label);
  return m ? m[1] : label.replace(/^\d{4}-(\d{2})-(\d{2})/, "$2.$1");
}

export function HeatmapTable({ series }: { series: SeriesPoint[] }) {
  const machines = series[0]?.machines ?? [];
  return (
    <Table>
      <thead>
        <tr>
          <th>Makine</th>
          {series.map((s) => (
            <th key={s.label} className="text-right">{colLabel(s.label)}</th>
          ))}
        </tr>
      </thead>
      <tbody className="tabular">
        {machines.map((m, row) => (
          <tr key={m.machine_id}>
            <td className="font-medium">{m.code}</td>
            {series.map((s) => (
              <td key={s.label} className="text-right">{pct(s.machines?.[row]?.oee, 0)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export function Heatmap({ series }: { series: SeriesPoint[] }) {
  const [hover, setHover] = useState<{ x: number; y: number; title: string; m: NonNullable<SeriesPoint["machines"]>[number] } | null>(null);
  const machines = series[0]?.machines ?? [];

  return (
    <div className="relative overflow-x-auto px-2" onMouseLeave={() => setHover(null)}>
      <div className="grid gap-0.5" style={{ gridTemplateColumns: `110px repeat(${series.length}, minmax(22px, 1fr))` }}>
        <div />
        {series.map((s, i) => (
          <div key={s.label} className="pb-1 text-center text-[11px] text-muted">
            {series.length > 16 && i % 2 ? "" : colLabel(s.label)}
          </div>
        ))}
        {machines.map((m, row) => (
          <Fragment key={m.machine_id}>
            <div className="truncate pr-2 text-[12px] leading-7 text-ink-2">{m.code}</div>
            {series.map((s) => {
              const cell = s.machines?.[row];
              const v = cell?.oee;
              const has = v !== null && v !== undefined;
              // Planlı süre var ama OEE hesaplanamıyor (ör. iş emri yok) ≠ planlı üretim/veri yok
              const unknown = !has && (cell?.planned_seconds ?? 0) > 0;
              return (
                <div
                  key={s.label}
                  className="flex h-7 items-center justify-center rounded-[3px] text-[10px] font-medium"
                  style={{
                    background: has ? color(v) : unknown ? "var(--surface)" : "var(--surface-2)",
                    color: has ? inkOn(v) : "var(--muted)",
                    boxShadow: unknown ? "inset 0 0 0 1px var(--axis)" : undefined,
                    // Veri/plan yoksa dokulu (45°) — boş hücre sıfırla karışmasın
                    backgroundImage: has || unknown ? undefined : "repeating-linear-gradient(45deg, transparent 0 4px, var(--grid) 4px 5px)",
                  }}
                  onMouseEnter={(e) => cell && setHover({ x: (e.currentTarget as HTMLElement).offsetLeft, y: (e.currentTarget as HTMLElement).offsetTop, title: `${m.code} · ${s.label}`, m: cell })}
                  aria-label={`${m.code} ${s.label}: ${has ? pct(v, 0) : unknown ? "OEE hesaplanamadı" : "planlı üretim yok"}`}
                >
                  {has && series.length <= 12 ? Math.round(v * 100) : unknown ? "?" : ""}
                </div>
              );
            })}
          </Fragment>
        ))}
      </div>
      {/* Ölçek lejantı */}
      <div className="mt-3 flex items-center gap-2 text-[11px] text-muted">
        <span>%0</span>
        <div className="flex">
          {RAMP.map((c) => (
            <span key={c} className="h-2.5 w-6" style={{ background: c }} />
          ))}
        </div>
        <span>%100</span>
        <span className="ml-3 inline-block h-2.5 w-6 rounded-[2px]" style={{ backgroundImage: "repeating-linear-gradient(45deg, var(--surface-2) 0 4px, var(--grid) 4px 5px)" }} />
        <span>planlı üretim yok / veri yok</span>
        <span className="ml-3 inline-flex h-2.5 w-6 items-center justify-center rounded-[2px] text-[9px] shadow-[inset_0_0_0_1px_var(--axis)]">?</span>
        <span>OEE hesaplanamadı (iş emri / çevrim süresi eksik)</span>
      </div>
      {hover && (
        <div className="pointer-events-none absolute z-10" style={{ left: hover.x + 30, top: hover.y + 30 }}>
          <TooltipBox
            title={hover.title}
            rows={[
              { label: "OEE", value: pct(hover.m.oee) },
              { label: "Kullanılabilirlik", value: pct(hover.m.availability) },
              { label: "Performans", value: pct(hover.m.performance) },
              { label: "Kalite", value: pct(hover.m.quality) },
              { label: "Adet", value: num(hover.m.total_count) },
            ]}
          />
        </div>
      )}
    </div>
  );
}
