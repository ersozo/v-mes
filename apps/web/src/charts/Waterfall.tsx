import { BarChart3, Rows3 } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ChartType } from "../components/ChartCard";
import { duration, pct } from "../lib/format";
import type { OeeMetrics } from "../lib/types";
import { axisProps, gridProps, Legend, TooltipBox } from "./common";

export type WaterfallType = "waterfall" | "stacked";
export const WATERFALL_TYPES: ChartType<WaterfallType>[] = [
  { value: "waterfall", label: "Şelale", icon: <BarChart3 className="size-3.5" /> },
  { value: "stacked", label: "Yığılmış", icon: <Rows3 className="size-3.5" /> },
];

const TOTAL = "var(--series-1)";
const LOSS = "var(--series-2)";

export const waterfallLegend = (
  <Legend items={[{ color: TOTAL, label: "Süre", shape: "square" }, { color: LOSS, label: "Kayıp", shape: "square" }]} />
);

interface Step {
  name: string;
  kind: "total" | "loss";
  value: number;
  base: number;
  share: number;
}

export function lossSteps(m: OeeMetrics): Step[] | null {
  const l = m.losses;
  if (m.planned_seconds <= 0 || l.performance_seconds === null || l.quality_seconds === null || l.fully_productive_seconds === null) return null;
  const P = m.planned_seconds;
  const run = m.run_seconds;
  const net = run - Math.max(l.performance_seconds, 0);
  const full = l.fully_productive_seconds;
  return [
    { name: "Planlı süre", kind: "total", value: P, base: 0, share: 1 },
    { name: "Duruş kaybı", kind: "loss", value: l.availability_seconds, base: run, share: l.availability_seconds / P },
    { name: "Çalışma", kind: "total", value: run, base: 0, share: run / P },
    { name: "Hız kaybı", kind: "loss", value: Math.max(l.performance_seconds, 0), base: net, share: Math.max(l.performance_seconds, 0) / P },
    { name: "Net çalışma", kind: "total", value: net, base: 0, share: net / P },
    { name: "Kalite kaybı", kind: "loss", value: l.quality_seconds, base: full, share: l.quality_seconds / P },
    { name: "Tam verimli", kind: "total", value: full, base: 0, share: full / P },
  ];
}

export function Waterfall({ metrics, type }: { metrics: OeeMetrics; type: WaterfallType }) {
  const steps = lossSteps(metrics);
  if (!steps) {
    return <p className="px-3 py-10 text-center text-ink-2">Kayıp şelalesi için performans hesaplanabilmeli (iş emri ve ideal çevrim süresi gerekli).</p>;
  }

  if (type === "stacked") {
    // Planlı sürenin tek çubukta dağılımı: tam verimli + üç kayıp
    const parts = [
      { name: "Tam verimli", value: steps[6]!.value, color: TOTAL },
      { name: "Duruş kaybı", value: steps[1]!.value, color: LOSS },
      { name: "Hız kaybı", value: steps[3]!.value, color: "color-mix(in oklab, var(--series-2) 70%, var(--surface))" },
      { name: "Kalite kaybı", value: steps[5]!.value, color: "color-mix(in oklab, var(--series-2) 45%, var(--surface))" },
    ];
    const total = metrics.planned_seconds;
    return (
      <div className="px-3 py-6">
        <div className="flex h-8 w-full gap-0.5 overflow-hidden rounded" role="img" aria-label="Planlı sürenin dağılımı">
          {parts.map((p) => (
            <div key={p.name} title={`${p.name}: ${duration(p.value)} (${pct(p.value / total)})`} style={{ width: `${(p.value / total) * 100}%`, background: p.color }} className="first:rounded-l last:rounded-r" />
          ))}
        </div>
        <ul className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-4">
          {parts.map((p) => (
            <li key={p.name} className="flex flex-col">
              <span className="flex items-center gap-1.5 text-ink-2">
                <span className="inline-block size-2.5 rounded-sm" style={{ background: p.color }} aria-hidden />
                {p.name}
              </span>
              <span className="tabular font-medium">{duration(p.value)} · {pct(p.value / total)}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={steps} margin={{ top: 24, right: 12, bottom: 4, left: 4 }} barCategoryGap="22%">
        <CartesianGrid {...gridProps} />
        <XAxis dataKey="name" {...axisProps} interval={0} tick={{ fill: "var(--muted)", fontSize: 11 }} />
        <YAxis {...axisProps} axisLine={false} width={56} tickFormatter={(v: number) => duration(v)} />
        <Tooltip
          cursor={{ fill: "var(--surface-2)" }}
          content={(p) => {
            const s = (p as { active?: boolean; payload?: readonly { payload: Step }[] }).payload?.[0]?.payload;
            if (!(p as { active?: boolean }).active || !s) return null;
            return <TooltipBox title={s.name} rows={[{ label: "Süre", value: duration(s.value) }, { label: "Planlı sürenin", value: pct(s.share) }]} />;
          }}
        />
        {/* Görünmez taban + görünür değer: yüzen kayıp çubukları */}
        <Bar dataKey="base" stackId="w" fill="transparent" isAnimationActive={false} />
        <Bar dataKey="value" stackId="w" maxBarSize={56} radius={[4, 4, 0, 0]} isAnimationActive={false}>
          {steps.map((s) => (
            <Cell key={s.name} fill={s.kind === "total" ? TOTAL : LOSS} />
          ))}
          <LabelList dataKey="share" position="top" formatter={(v: unknown) => pct(v as number, 0)} fill="var(--ink-2)" fontSize={11} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
