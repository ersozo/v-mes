import { BarChart3, Rows3, Table2 } from "lucide-react";
import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ChartType } from "../components/ChartCard";
import { Table } from "../components/ui";
import { duration, num, pct } from "../lib/format";
import type { OeeMetrics } from "../lib/types";
import { axisProps, BAR_MAX, gridProps, Legend, METRIC_COLORS, METRIC_LABELS, pctTick, TooltipBox } from "./common";

export type ComparisonType = "bar" | "grouped" | "table";
export const COMPARISON_TYPES: ChartType<ComparisonType>[] = [
  { value: "bar", label: "OEE sıralı", icon: <BarChart3 className="size-3.5 rotate-90" /> },
  { value: "grouped", label: "A / P / Q gruplu", icon: <Rows3 className="size-3.5" /> },
  { value: "table", label: "Tablo", icon: <Table2 className="size-3.5" /> },
];

export type ComparisonRow = OeeMetrics & { key: string | number; name: string };

export function comparisonLegend(type: ComparisonType) {
  return type === "grouped" ? (
    <Legend items={(["availability", "performance", "quality"] as const).map((k) => ({ color: METRIC_COLORS[k], label: METRIC_LABELS[k], shape: "square" as const }))} />
  ) : null;
}

export function ComparisonTable({ rows }: { rows: ComparisonRow[] }) {
  return (
    <Table>
      <thead>
        <tr>
          <th>Ad</th>
          <th className="text-right">OEE</th>
          <th className="text-right">Kullanılabilirlik</th>
          <th className="text-right">Performans</th>
          <th className="text-right">Kalite</th>
          <th className="text-right">Adet</th>
          <th className="text-right">Duruş</th>
        </tr>
      </thead>
      <tbody className="tabular">
        {rows.map((r) => (
          <tr key={r.key}>
            <td className="font-medium">{r.name}</td>
            <td className="text-right">{pct(r.oee)}</td>
            <td className="text-right">{pct(r.availability)}</td>
            <td className="text-right">{pct(r.performance)}</td>
            <td className="text-right">{pct(r.quality)}</td>
            <td className="text-right">{num(r.total_count)}</td>
            <td className="text-right">{duration(r.planned_seconds - r.run_seconds)}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export function Comparison({ rows, type, onTypeChange }: { rows: ComparisonRow[]; type: ComparisonType; onTypeChange?: (t: ComparisonType) => void }) {
  if (type === "table") return <ComparisonTable rows={rows} />;
  // "OEE sıralı" görünümünde OEE'si hesaplanamayanlar çubuk olarak çizilmez (sıfırla karışmasın), altta nedeniyle listelenir.
  const missing = type === "bar" ? rows.filter((r) => r.oee === null) : [];
  const plotted = type === "bar" ? [...rows].filter((r) => r.oee !== null).sort((a, b) => (b.oee ?? 0) - (a.oee ?? 0)) : rows;
  const perRow = type === "grouped" ? 56 : 34;
  const height = Math.max(120, plotted.length * perRow + 40);

  const missingNote = missing.length > 0 && (
    <div className="px-3 pt-2 text-[12px] text-muted">
      OEE hesaplanamadı: {missing.map((r) => r.name).join(", ")}
      {missing.some((r) => r.unattributed_count > 0) ? " — iş emri olmadan üretim var (ideal hız bilinmiyor)." : " — planlı üretim süresi yok."}
    </div>
  );

  if (plotted.length === 0) {
    return (
      <div className="px-3 py-8 text-center text-ink-2">
        <p>Seçilen kapsamdaki hiçbir makine için OEE hesaplanamadı.</p>
        {missingNote}
        {onTypeChange && (
          <button className="mt-3 text-accent hover:underline" onClick={() => onTypeChange("grouped")}>
            Kullanılabilirlik / performans / kaliteyi ayrı göster
          </button>
        )}
      </div>
    );
  }

  return (
    <>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={plotted} layout="vertical" margin={{ top: 4, right: 56, bottom: 4, left: 4 }} barGap={2} barCategoryGap={type === "grouped" ? 10 : 6}>
          <CartesianGrid {...gridProps} vertical horizontal={false} />
          <XAxis type="number" domain={[0, 1]} ticks={[0, 0.25, 0.5, 0.75, 1]} tickFormatter={pctTick} {...axisProps} />
          <YAxis type="category" dataKey="name" width={130} {...axisProps} axisLine={false} />
          <Tooltip
            cursor={{ fill: "var(--surface-2)" }}
            content={(p) => {
              const r = (p as { active?: boolean; payload?: readonly { payload: ComparisonRow }[] }).payload?.[0]?.payload;
              if (!(p as { active?: boolean }).active || !r) return null;
              return (
                <TooltipBox
                  title={r.name}
                  rows={[
                    { color: METRIC_COLORS.oee, label: "OEE", value: pct(r.oee) },
                    { color: METRIC_COLORS.availability, label: "Kullanılabilirlik", value: pct(r.availability) },
                    { color: METRIC_COLORS.performance, label: "Performans", value: pct(r.performance) },
                    { color: METRIC_COLORS.quality, label: "Kalite", value: pct(r.quality) },
                    { label: "Adet", value: num(r.total_count) },
                  ]}
                />
              );
            }}
          />
          {type === "bar" ? (
            <Bar dataKey="oee" fill={METRIC_COLORS.oee} maxBarSize={BAR_MAX} radius={[0, 4, 4, 0]}>
              {/* Değer çubuğun ucunda, metin renginde */}
              <LabelList dataKey="oee" position="right" formatter={(v: unknown) => pct(v as number | null)} fill="var(--ink-2)" fontSize={12} />
            </Bar>
          ) : (
            (["availability", "performance", "quality"] as const).map((k) => (
              <Bar key={k} dataKey={k} fill={METRIC_COLORS[k]} maxBarSize={12} radius={[0, 4, 4, 0]} />
            ))
          )}
        </BarChart>
      </ResponsiveContainer>
      {missingNote}
    </>
  );
}
