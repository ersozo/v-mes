import { BarChart3, ChartArea, ChartLine } from "lucide-react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ChartType } from "../components/ChartCard";
import { num } from "../lib/format";
import type { ProductionResponse } from "../lib/types";
import { axisProps, BAR_MAX, gridProps, Legend, SERIES, TooltipBox } from "./common";

export type ProductionType = "column" | "line" | "cumulative";
export const PRODUCTION_TYPES: ChartType<ProductionType>[] = [
  { value: "column", label: "Sütun", icon: <BarChart3 className="size-3.5" /> },
  { value: "line", label: "Çizgi", icon: <ChartLine className="size-3.5" /> },
  { value: "cumulative", label: "Kümülatif", icon: <ChartArea className="size-3.5" /> },
];

const GOOD = SERIES[0]!;
const SCRAP = SERIES[1]!;

export function productionLegend(type: ProductionType) {
  return type === "column" ? <Legend items={[{ color: GOOD, label: "İyi", shape: "square" }, { color: SCRAP, label: "Hurda", shape: "square" }]} /> : null;
}

const short = (l: string) => /(\d{2}:\d{2})$/.exec(l)?.[1] ?? l.replace(/^\d{4}-(\d{2})-(\d{2})/, "$2.$1");

export function Production({ data, type }: { data: ProductionResponse["series"]; type: ProductionType }) {
  let cum = 0;
  const rows = data.map((d) => ({ ...d, short: short(d.label), cumulative: (cum += d.good_count) }));
  const tooltip = (
    <Tooltip
      cursor={type === "column" ? { fill: "var(--surface-2)" } : { stroke: "var(--axis)" }}
      content={(p) => {
        const r = (p as { active?: boolean; payload?: readonly { payload: (typeof rows)[number] }[] }).payload?.[0]?.payload;
        if (!(p as { active?: boolean }).active || !r) return null;
        return (
          <TooltipBox
            title={r.label}
            rows={[
              { color: GOOD, label: "İyi", value: num(r.good_count) },
              { color: SCRAP, label: "Hurda", value: num(r.scrap_count) },
              { label: "Toplam", value: num(r.total_count) },
              ...(type === "cumulative" ? [{ label: "Kümülatif iyi", value: num(r.cumulative) }] : []),
            ]}
          />
        );
      }}
    />
  );
  const common = { data: rows, margin: { top: 12, right: 16, bottom: 4, left: 4 } };
  const x = <XAxis dataKey="short" {...axisProps} minTickGap={16} />;
  const y = <YAxis {...axisProps} axisLine={false} width={52} tickFormatter={(v: number) => num(v)} allowDecimals={false} />;

  return (
    <ResponsiveContainer width="100%" height={260}>
      {type === "column" ? (
        <BarChart {...common}>
          <CartesianGrid {...gridProps} />
          {x}
          {y}
          {tooltip}
          {/* Yığın segmentleri arasında 2px zemin boşluğu */}
          <Bar dataKey="good_count" stackId="p" fill={GOOD} maxBarSize={BAR_MAX} stroke="var(--surface)" strokeWidth={1} />
          <Bar dataKey="scrap_count" stackId="p" fill={SCRAP} maxBarSize={BAR_MAX} radius={[4, 4, 0, 0]} stroke="var(--surface)" strokeWidth={1} />
        </BarChart>
      ) : type === "line" ? (
        <LineChart {...common}>
          <CartesianGrid {...gridProps} />
          {x}
          {y}
          {tooltip}
          <Line type="monotone" dataKey="total_count" stroke={GOOD} strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }} />
        </LineChart>
      ) : (
        <AreaChart {...common}>
          <CartesianGrid {...gridProps} />
          {x}
          {y}
          {tooltip}
          <Area type="stepAfter" dataKey="cumulative" stroke={GOOD} strokeWidth={2} fill={GOOD} fillOpacity={0.1} />
        </AreaChart>
      )}
    </ResponsiveContainer>
  );
}
