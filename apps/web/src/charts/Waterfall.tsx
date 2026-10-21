import { BarChart3, ChartPie, Rows3 } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Cell, LabelList, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ChartType } from "../components/ChartCard";
import { Table } from "../components/ui";
import { duration, pct } from "../lib/format";
import type { OeeMetrics } from "../lib/types";
import { axisProps, gridProps, Legend, TooltipBox } from "./common";

export type WaterfallType = "waterfall" | "stacked" | "donut";
export const WATERFALL_TYPES: ChartType<WaterfallType>[] = [
  { value: "waterfall", label: "Şelale", icon: <BarChart3 className="size-3.5" /> },
  { value: "stacked", label: "Yığılmış", icon: <Rows3 className="size-3.5" /> },
  { value: "donut", label: "Halka", icon: <ChartPie className="size-3.5" /> },
];

const TOTAL = "var(--series-1)";
const LOSS = "var(--series-2)";

/** Yalnızca şelale görünümünde; yığılmış ve halka kendi değer listesini gösterir. */
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

interface Part {
  name: string;
  value: number;
  color: string;
}

/** Planlı sürenin dağılımı: tam verimli + üç kayıp (toplamı planlı süre). */
function lossParts(steps: Step[]): Part[] {
  return [
    { name: "Tam verimli", value: steps[6]!.value, color: TOTAL },
    { name: "Duruş kaybı", value: steps[1]!.value, color: LOSS },
    { name: "Hız kaybı", value: steps[3]!.value, color: "color-mix(in oklab, var(--series-2) 70%, var(--surface))" },
    { name: "Kalite kaybı", value: steps[5]!.value, color: "color-mix(in oklab, var(--series-2) 45%, var(--surface))" },
  ];
}

function PartList({ parts, total, className }: { parts: Part[]; total: number; className?: string }) {
  return (
    <ul className={className ?? "grid grid-cols-2 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-4"}>
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
  );
}

export function WaterfallTable({ metrics }: { metrics: OeeMetrics }) {
  const steps = lossSteps(metrics);
  if (!steps) return <p className="py-6 text-center text-ink-2">Performans hesaplanamadığı için kayıp dağılımı yok.</p>;
  return (
    <Table>
      <thead>
        <tr>
          <th>Adım</th>
          <th className="text-right">Süre</th>
          <th className="text-right">Planlı sürenin</th>
        </tr>
      </thead>
      <tbody className="tabular">
        {steps.map((s) => (
          <tr key={s.name}>
            <td className={s.kind === "total" ? "font-medium" : "pl-6 text-ink-2"}>{s.kind === "loss" ? `− ${s.name}` : s.name}</td>
            <td className="text-right">{duration(s.value)}</td>
            <td className="text-right">{pct(s.share)}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export function Waterfall({ metrics, type }: { metrics: OeeMetrics; type: WaterfallType }) {
  const steps = lossSteps(metrics);
  if (!steps) {
    return <p className="px-3 py-10 text-center text-ink-2">Kayıp şelalesi için performans hesaplanabilmeli (iş emri ve ideal çevrim süresi gerekli).</p>;
  }

  const total = metrics.planned_seconds;
  const parts = lossParts(steps);

  if (type === "stacked") {
    // Planlı sürenin tek çubukta dağılımı
    return (
      <div className="px-3 py-6">
        <div className="flex h-8 w-full gap-0.5 overflow-hidden rounded" role="img" aria-label="Planlı sürenin dağılımı">
          {parts.map((p) => (
            <div key={p.name} title={`${p.name}: ${duration(p.value)} (${pct(p.value / total)})`} style={{ width: `${(p.value / total) * 100}%`, background: p.color }} className="first:rounded-l last:rounded-r" />
          ))}
        </div>
        <PartList parts={parts} total={total} className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-4" />
      </div>
    );
  }

  if (type === "donut") {
    // Tam verimli süre / planlı süre = OEE → ortada OEE
    const oee = metrics.oee ?? steps[6]!.value / total;
    return (
      <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-4 px-3 py-4">
        <div className="relative size-[200px] shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Tooltip
                content={(p) => {
                  const d = (p as { active?: boolean; payload?: readonly { payload: Part }[] }).payload?.[0]?.payload;
                  if (!(p as { active?: boolean }).active || !d) return null;
                  return <TooltipBox title={d.name} rows={[{ color: d.color, label: "Süre", value: duration(d.value) }, { label: "Planlı sürenin", value: pct(d.value / total) }]} />;
                }}
              />
              <Pie data={parts.filter((p) => p.value > 0)} dataKey="value" nameKey="name" innerRadius="70%" outerRadius="100%" startAngle={90} endAngle={-270}
                stroke="var(--surface)" strokeWidth={2} isAnimationActive={false}>
                {parts.filter((p) => p.value > 0).map((p) => <Cell key={p.name} fill={p.color} />)}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="tabular text-[28px] font-semibold leading-none text-ink">{pct(oee, 1)}</span>
            <span className="mt-1 text-[12px] text-muted">OEE</span>
          </div>
        </div>
        <PartList parts={parts} total={total} className="grid grid-cols-2 gap-x-6 gap-y-3 text-[13px]" />
      </div>
    );
  }

  return (
    <>
      <div className="px-2 pb-1">{waterfallLegend}</div>
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
    </>
  );
}
