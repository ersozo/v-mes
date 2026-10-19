import { BarChart3, ChartArea, ChartLine, LayoutGrid } from "lucide-react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ChartType } from "../components/ChartCard";
import { pct } from "../lib/format";
import type { SeriesPoint } from "../lib/types";
import { axisProps, BAR_MAX, gridProps, Legend, METRIC_COLORS, METRIC_LABELS, pctTick, TooltipBox } from "./common";

export type TrendType = "line" | "area" | "bar" | "multiples";
export const TREND_TYPES: ChartType<TrendType>[] = [
  { value: "line", label: "Çizgi", icon: <ChartLine className="size-3.5" /> },
  { value: "area", label: "Alan", icon: <ChartArea className="size-3.5" /> },
  { value: "bar", label: "Sütun", icon: <BarChart3 className="size-3.5" /> },
  { value: "multiples", label: "A / P / Q ayrı", icon: <LayoutGrid className="size-3.5" /> },
];

type Metric = keyof typeof METRIC_COLORS;
const METRICS: Metric[] = ["oee", "availability", "performance", "quality"];

function shortLabel(label: string): string {
  // "2026-10-19 08:00" → "08:00", "2026-10-19 Vardiya 1" → "19.10 Vardiya 1", "2026-10-19" → "19.10"
  const m = /^(\d{4})-(\d{2})-(\d{2})(?: (.*))?$/.exec(label);
  if (!m) return label;
  const [, , mo, d, rest] = m;
  if (rest && /^\d{2}:\d{2}$/.test(rest)) return rest;
  return rest ? `${d}.${mo} ${rest}` : `${d}.${mo}`;
}

function TrendTooltip({ active, payload, metrics }: { active?: boolean; payload?: readonly { payload: SeriesPoint }[]; metrics: Metric[] }) {
  const p = active ? payload?.[0]?.payload : undefined;
  if (!p) return null;
  return (
    <TooltipBox
      title={p.label}
      rows={[
        ...metrics.map((k) => ({ color: METRIC_COLORS[k], label: METRIC_LABELS[k], value: pct(p[k]) })),
        { label: "Adet", value: p.total_count.toLocaleString("tr-TR") },
      ]}
    />
  );
}

export function trendLegend(type: TrendType) {
  if (type === "multiples") return null;
  const metrics: Metric[] = type === "line" ? METRICS : ["oee"];
  return metrics.length > 1 ? <Legend items={metrics.map((k) => ({ color: METRIC_COLORS[k], label: METRIC_LABELS[k], shape: "line" as const }))} /> : null;
}

/** Çizgide komşusu olmayan (tek başına kalan) noktalar görünsün diye ≥8px işaret. */
function isolatedDot(key: Metric, rows: SeriesPoint[], color: string) {
  return (props: { cx?: number; cy?: number; index?: number }) => {
    const i = props.index ?? -1;
    const v = rows[i]?.[key];
    const lone = v !== null && v !== undefined && rows[i - 1]?.[key] == null && rows[i + 1]?.[key] == null;
    if (!lone || props.cx === undefined || props.cy === undefined) return <g key={`${key}-${i}`} />;
    return <circle key={`${key}-${i}`} cx={props.cx} cy={props.cy} r={4} fill={color} stroke="var(--surface)" strokeWidth={2} />;
  };
}

export function OeeTrend({ data, type, height = 280 }: { data: SeriesPoint[]; type: TrendType; height?: number }) {
  const rows = data.map((d) => ({ ...d, short: shortLabel(d.label) }));
  const common = { data: rows, margin: { top: 12, right: 24, bottom: 4, left: 4 } };
  const x = <XAxis dataKey="short" {...axisProps} minTickGap={16} />;
  const y = <YAxis {...axisProps} axisLine={false} domain={[0, 1]} ticks={[0, 0.25, 0.5, 0.75, 1]} tickFormatter={pctTick} width={44} />;

  if (type === "multiples") {
    return (
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {METRICS.map((k) => (
          <div key={k}>
            <div className="px-2 text-[12px] font-medium text-ink-2">{METRIC_LABELS[k]}</div>
            <ResponsiveContainer width="100%" height={140}>
              <AreaChart {...common} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                <CartesianGrid {...gridProps} />
                {x}
                {y}
                <Tooltip cursor={{ stroke: "var(--axis)" }} content={(p) => <TrendTooltip {...(p as object)} metrics={[k]} />} />
                <Area type="monotone" dataKey={k} stroke={METRIC_COLORS[k]} strokeWidth={2} fill={METRIC_COLORS[k]} fillOpacity={0.1} connectNulls={false} isAnimationActive={false} dot={isolatedDot(k, rows, METRIC_COLORS[k])} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ))}
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      {type === "bar" ? (
        <BarChart {...common}>
          <CartesianGrid {...gridProps} />
          {x}
          {y}
          <Tooltip cursor={{ fill: "var(--surface-2)" }} content={(p) => <TrendTooltip {...(p as object)} metrics={METRICS} />} />
          <Bar dataKey="oee" fill={METRIC_COLORS.oee} maxBarSize={BAR_MAX} radius={[4, 4, 0, 0]} />
        </BarChart>
      ) : type === "area" ? (
        <AreaChart {...common}>
          <CartesianGrid {...gridProps} />
          {x}
          {y}
          <Tooltip cursor={{ stroke: "var(--axis)" }} content={(p) => <TrendTooltip {...(p as object)} metrics={METRICS} />} />
          <Area type="monotone" dataKey="oee" stroke={METRIC_COLORS.oee} strokeWidth={2} fill={METRIC_COLORS.oee} fillOpacity={0.1} dot={isolatedDot("oee", rows, METRIC_COLORS.oee)} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }} />
        </AreaChart>
      ) : (
        <LineChart {...common}>
          <CartesianGrid {...gridProps} />
          {x}
          {y}
          <Tooltip cursor={{ stroke: "var(--axis)" }} content={(p) => <TrendTooltip {...(p as object)} metrics={METRICS} />} />
          {METRICS.map((k) => (
            <Line
              key={k}
              type="monotone"
              dataKey={k}
              stroke={METRIC_COLORS[k]}
              strokeWidth={k === "oee" ? 2.5 : 2}
              strokeOpacity={k === "oee" ? 1 : 0.85}
              dot={isolatedDot(k, rows, METRIC_COLORS[k])}
              activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }}
              connectNulls={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      )}
    </ResponsiveContainer>
  );
}
