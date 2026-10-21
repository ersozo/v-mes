import { BarChart3, LayoutDashboard } from "lucide-react";
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, Treemap, XAxis, YAxis } from "recharts";
import type { ChartType } from "../components/ChartCard";
import { CATEGORY_META } from "../components/state";
import { Table } from "../components/ui";
import { duration, num, pct } from "../lib/format";
import type { ParetoReason } from "../lib/types";
import { axisProps, BAR_MAX, Legend, TooltipBox } from "./common";

export type ParetoType = "bar" | "treemap";
export const PARETO_TYPES: ChartType<ParetoType>[] = [
  { value: "bar", label: "Pareto", icon: <BarChart3 className="size-3.5 rotate-90" /> },
  { value: "treemap", label: "Ağaç harita", icon: <LayoutDashboard className="size-3.5" /> },
];

export function paretoLegend(reasons: ParetoReason[]) {
  const cats = [...new Set(reasons.map((r) => r.category))];
  return cats.length > 1 ? <Legend items={cats.map((c) => ({ color: CATEGORY_META[c].color, label: CATEGORY_META[c].label, shape: "square" as const }))} /> : null;
}

function ReasonTooltip({ r }: { r: ParetoReason }) {
  return (
    <TooltipBox
      title={r.name}
      rows={[
        { color: CATEGORY_META[r.category].color, label: CATEGORY_META[r.category].label, value: "" },
        { label: "Toplam süre", value: duration(r.seconds) },
        { label: "Duruş sayısı", value: num(r.count) },
        { label: "Pay", value: pct(r.share) },
        { label: "Kümülatif pay", value: pct(r.cumulative_share) },
      ]}
    />
  );
}

export function ParetoTable({ reasons }: { reasons: ParetoReason[] }) {
  return (
    <Table>
      <thead>
        <tr>
          <th>Neden</th>
          <th>Kategori</th>
          <th className="text-right">Süre</th>
          <th className="text-right">Adet</th>
          <th className="text-right">Pay</th>
          <th className="text-right">Kümülatif</th>
        </tr>
      </thead>
      <tbody className="tabular">
        {reasons.map((r) => (
          <tr key={r.reason_id ?? "none"}>
            <td className="font-medium">{r.name}</td>
            <td className="text-ink-2">{CATEGORY_META[r.category].label}</td>
            <td className="text-right">{duration(r.seconds)}</td>
            <td className="text-right">{num(r.count)}</td>
            <td className="text-right">{pct(r.share)}</td>
            <td className="text-right">{pct(r.cumulative_share)}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/**
 * Pareto: azalan sıralı yatay çubuklar + sağda kümülatif pay sütunu.
 * Klasik "çubuk + kümülatif çizgi" iki farklı ölçek (süre ve %) gerektirdiği için kullanılmaz (çift eksen yok).
 * Kümülatif %80'e ulaşan nedenler "vital few" olarak vurgulanır.
 */
export function Pareto({ reasons, type, onSelect }: { reasons: ParetoReason[]; type: ParetoType; onSelect?: (r: ParetoReason) => void }) {
  if (type === "treemap") {
    const data = reasons.map((r) => ({ ...r, size: r.seconds }));
    return (
      <ResponsiveContainer width="100%" height={300}>
        <Treemap data={data} dataKey="size" nameKey="name" isAnimationActive={false} stroke="var(--surface)" content={<TreemapCell />}>
          <Tooltip content={(p) => {
            const r = (p as { payload?: readonly { payload: ParetoReason }[] }).payload?.[0]?.payload;
            return r ? <ReasonTooltip r={r} /> : null;
          }} />
        </Treemap>
      </ResponsiveContainer>
    );
  }

  const top = reasons.slice(0, 12);
  const firstOver80 = top.findIndex((r) => r.cumulative_share >= 0.8);
  const height = Math.max(140, top.length * 34 + 24);
  return (
    <div className="flex">
      <div className="min-w-0 flex-1">
        <ResponsiveContainer width="100%" height={height}>
          <BarChart data={top} layout="vertical" margin={{ top: 4, right: 64, bottom: 4, left: 4 }} barCategoryGap={6}>
            <XAxis type="number" hide domain={[0, "dataMax"]} />
            <YAxis type="category" dataKey="name" width={150} {...axisProps} axisLine={false} />
            <Tooltip cursor={{ fill: "var(--surface-2)" }} content={(p) => {
              const r = (p as { active?: boolean; payload?: readonly { payload: ParetoReason }[] }).payload?.[0]?.payload;
              return (p as { active?: boolean }).active && r ? <ReasonTooltip r={r} /> : null;
            }} />
            <Bar
              dataKey="seconds"
              maxBarSize={BAR_MAX}
              radius={[0, 4, 4, 0]}
              label={{ position: "right", fill: "var(--ink-2)", fontSize: 12, formatter: (v: unknown) => duration(v as number) }}
              onClick={(d: unknown) => onSelect?.((d as { payload: ParetoReason }).payload)}
              cursor={onSelect ? "pointer" : undefined}
            >
              {top.map((r, i) => (
                <Cell key={r.reason_id ?? "none"} fill={CATEGORY_META[r.category].color} fillOpacity={firstOver80 === -1 || i <= firstOver80 ? 1 : 0.45} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      {/* Kümülatif pay: ayrı sütun, aynı satır hizasında (ikinci eksen yerine) */}
      <div className="w-20 shrink-0 pt-1 text-right text-[12px]" aria-label="Kümülatif pay">
        {top.map((r, i) => (
          <div key={r.reason_id ?? "none"} className="tabular flex items-center justify-end pr-3" style={{ height: (height - 8) / top.length }}>
            <span className={i <= firstOver80 || firstOver80 === -1 ? "font-medium text-ink" : "text-muted"}>{pct(r.cumulative_share, 0)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TreemapCell(props: { x?: number; y?: number; width?: number; height?: number; name?: string; category?: ParetoReason["category"]; seconds?: number }) {
  const { x = 0, y = 0, width = 0, height = 0, name, category, seconds } = props;
  if (!category) return null;
  const fits = width > 70 && height > 34;
  return (
    <g>
      <rect x={x} y={y} width={width} height={height} rx={4} fill={CATEGORY_META[category].color} stroke="var(--surface)" strokeWidth={2} />
      {fits && (
        <>
          <text x={x + 8} y={y + 18} fill="#ffffff" fontSize={12} fontWeight={600}>
            {name && name.length * 7 > width - 16 ? name.slice(0, Math.max(3, Math.floor((width - 16) / 7))) + "…" : name}
          </text>
          <text x={x + 8} y={y + 32} fill="#ffffff" fontSize={11} opacity={0.9}>
            {duration(seconds)}
          </text>
        </>
      )}
    </g>
  );
}
