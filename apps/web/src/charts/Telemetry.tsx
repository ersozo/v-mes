import { ChartArea, ChartLine, ChartScatter } from "lucide-react";
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Scatter, Tooltip, XAxis, YAxis } from "recharts";
import type { ChartType } from "../components/ChartCard";
import { num, timeSec } from "../lib/format";
import { axisProps, gridProps, SERIES, TooltipBox } from "./common";

export type TelemetryType = "line" | "band" | "dots";
export const TELEMETRY_TYPES: ChartType<TelemetryType>[] = [
  { value: "line", label: "Çizgi", icon: <ChartLine className="size-3.5" /> },
  { value: "band", label: "Min–maks bandı", icon: <ChartArea className="size-3.5" /> },
  { value: "dots", label: "Nokta", icon: <ChartScatter className="size-3.5" /> },
];

export interface TelemetryPoint {
  t: number;
  avg: number;
  min: number;
  max: number;
}

/** Tek tag, tek eksen (farklı birimli tag'ler ayrı grafiklerde gösterilir). */
export function TelemetryChart({ points, type, unit, colorIndex = 0 }: { points: TelemetryPoint[]; type: TelemetryType; unit?: string | null; colorIndex?: number }) {
  const color = SERIES[colorIndex % SERIES.length]!;
  const rows = points.map((p) => ({ ...p, range: [p.min, p.max] as [number, number] }));
  return (
    <ResponsiveContainer width="100%" height={180}>
      <ComposedChart data={rows} margin={{ top: 8, right: 16, bottom: 0, left: 4 }}>
        <CartesianGrid {...gridProps} />
        <XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]} {...axisProps} tickFormatter={(v: number) => timeSec(new Date(v).toISOString()).slice(0, 5)} minTickGap={40} />
        <YAxis {...axisProps} axisLine={false} width={48} domain={["auto", "auto"]} tickFormatter={(v: number) => num(v, 1)} />
        <Tooltip
          cursor={{ stroke: "var(--axis)" }}
          content={(p) => {
            const r = (p as { active?: boolean; payload?: readonly { payload: TelemetryPoint }[] }).payload?.[0]?.payload;
            if (!(p as { active?: boolean }).active || !r) return null;
            const u = unit ? ` ${unit}` : "";
            return (
              <TooltipBox
                title={timeSec(new Date(r.t).toISOString())}
                rows={[
                  { color, label: "Ortalama", value: `${num(r.avg, 1)}${u}` },
                  ...(r.min !== r.max ? [{ label: "Min / maks", value: `${num(r.min, 1)} / ${num(r.max, 1)}${u}` }] : []),
                ]}
              />
            );
          }}
        />
        {type === "band" && <Area dataKey="range" stroke="none" fill={color} fillOpacity={0.12} isAnimationActive={false} />}
        {type === "dots" ? (
          <Scatter dataKey="avg" fill={color} shape={(props: { cx?: number; cy?: number }) => <circle cx={props.cx} cy={props.cy} r={2.5} fill={color} />} isAnimationActive={false} />
        ) : (
          <Line dataKey="avg" stroke={color} strokeWidth={2} dot={false} isAnimationActive={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }} />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
}
