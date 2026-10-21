// İstasyonlar (darboğaz analizi): seri istasyonlu makinede istasyon başına çalışma oranı ve zaman şeridi.
import { BarChart3, ChartGantt } from "lucide-react";
import { Fragment, useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ChartType } from "../components/ChartCard";
import { Badge, Table } from "../components/ui";
import { duration, num, pct, time } from "../lib/format";
import type { StationsResponse } from "../lib/types";
import { axisProps, BAR_MAX, gridProps, pctTick, TooltipBox } from "./common";

export type StationsType = "bar" | "strip";
export const STATIONS_TYPES: ChartType<StationsType>[] = [
  { value: "bar", label: "Çalışma oranı", icon: <BarChart3 className="size-3.5 rotate-90" /> },
  { value: "strip", label: "Zaman şeridi", icon: <ChartGantt className="size-3.5" /> },
];

/** Sıralı tek ton rampa (ısı haritasıyla aynı); açık = az çalışıyor. */
const RAMP = ["var(--seq-100)", "var(--seq-200)", "var(--seq-300)", "var(--seq-400)", "var(--seq-500)", "var(--seq-600)", "var(--seq-700)"];
const rampColor = (v: number) => RAMP[Math.min(RAMP.length - 1, Math.floor(Math.max(0, Math.min(0.9999, v)) * RAMP.length))]!;
// Darboğaz adayı tam vurgu rengiyle, diğerleri yüzeye karıştırılmış silik tonla (her iki temada da kontrastlı)
const BAR = "color-mix(in oklab, var(--series-1) 40%, var(--surface))";
const BAR_BOTTLENECK = "var(--series-1)";

const stationLabel = (n: number) => `${n}. istasyon`;

export function StationsChart({ data, type, pollMs }: { data: StationsResponse; type: StationsType; pollMs: number }) {
  if (type === "strip") return <StationsStrip data={data} />;

  const rows = data.stations.map((s) => ({ ...s, name: stationLabel(s.station), ratio: s.run_ratio ?? 0 }));
  return (
    <>
      <ResponsiveContainer width="100%" height={Math.max(120, rows.length * 34 + 40)}>
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 120, bottom: 4, left: 4 }} barCategoryGap={6}>
          <CartesianGrid {...gridProps} vertical horizontal={false} />
          <XAxis type="number" domain={[0, 1]} ticks={[0, 0.25, 0.5, 0.75, 1]} tickFormatter={pctTick} {...axisProps} />
          <YAxis type="category" dataKey="name" width={90} {...axisProps} axisLine={false} />
          <Tooltip
            cursor={{ fill: "var(--surface-2)" }}
            content={(p) => {
              const r = (p as { active?: boolean; payload?: readonly { payload: (typeof rows)[number] }[] }).payload?.[0]?.payload;
              if (!(p as { active?: boolean }).active || !r) return null;
              return (
                <TooltipBox
                  title={`${r.name}${r.station === data.bottleneck_station ? " · darboğaz adayı" : ""}`}
                  rows={[
                    { color: r.station === data.bottleneck_station ? BAR_BOTTLENECK : BAR, label: "Çalışma oranı", value: pct(r.run_ratio) },
                    { label: "Çalışma süresi (yaklaşık)", value: duration(Math.round((r.run_ratio ?? 0) * r.samples * pollMs / 1000)) },
                    { label: "Tag", value: r.tag },
                  ]}
                />
              );
            }}
          />
          <Bar dataKey="ratio" maxBarSize={BAR_MAX} radius={[0, 4, 4, 0]} isAnimationActive={false}>
            {rows.map((r) => <Cell key={r.station} fill={r.station === data.bottleneck_station ? BAR_BOTTLENECK : BAR} />)}
            {/* Değer çubuğun ucunda, metin renginde; darboğaz adayı ayrıca yazıyla belirtilir (renk tek başına değil) */}
            <LabelList
              dataKey="station"
              position="right"
              fill="var(--ink-2)"
              fontSize={12}
              formatter={(v: unknown) => {
                const s = rows.find((r) => r.station === v);
                if (!s) return "";
                if (s.run_ratio === null) return "veri yok";
                return `${pct(s.run_ratio)}${s.station === data.bottleneck_station ? " · darboğaz adayı" : ""}`;
              }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <p className="px-3 pt-1 text-[12px] text-muted">
        Seri hatta en yavaş istasyon en uzun çalışır, diğerleri onu bekler. En yüksek çalışma oranı darboğaz adayıdır.
      </p>
    </>
  );
}

function StationsStrip({ data }: { data: StationsResponse }) {
  const [hover, setHover] = useState<{ x: number; y: number; title: string; ratio: number; samples: number } | null>(null);
  const start = new Date(data.window.from).getTime();
  const end = new Date(data.window.to).getTime();
  const step = data.bucket_seconds * 1000;
  const cols = Math.max(1, Math.ceil((end - start) / step));
  // Kova zaman damgası → sütun; boş kovalar (veri yok) dokulu gösterilir
  const colOf = (iso: string) => Math.round((new Date(iso).getTime() - start) / step);
  const tickEvery = Math.max(1, Math.ceil(cols / 8));

  return (
    <div className="relative overflow-x-auto px-2" onMouseLeave={() => setHover(null)}>
      <div className="grid gap-y-0.5" style={{ gridTemplateColumns: `90px repeat(${cols}, minmax(3px, 1fr))` }}>
        {data.stations.map((s) => {
          const byCol = new Map(s.buckets.map((b) => [colOf(b.ts), b]));
          return (
            <Fragment key={s.station}>
              <div className="truncate pr-2 text-[12px] leading-6 text-ink-2">
                {stationLabel(s.station)}
                {s.station === data.bottleneck_station && <span className="ml-1 text-[11px] text-muted">★</span>}
              </div>
              {Array.from({ length: cols }, (_, c) => {
                const b = byCol.get(c);
                return (
                  <div
                    key={c}
                    className="h-6"
                    style={{
                      background: b ? rampColor(b.run_ratio) : "var(--surface-2)",
                      backgroundImage: b ? undefined : "repeating-linear-gradient(45deg, transparent 0 4px, var(--grid) 4px 5px)",
                    }}
                    onMouseEnter={(e) => {
                      const el = e.currentTarget as HTMLElement;
                      if (b) setHover({ x: el.offsetLeft, y: el.offsetTop, title: `${stationLabel(s.station)} · ${time(b.ts)}`, ratio: b.run_ratio, samples: b.samples });
                      else setHover(null);
                    }}
                    aria-label={`${stationLabel(s.station)} ${time(new Date(start + c * step).toISOString())}: ${b ? pct(b.run_ratio, 0) : "veri yok"}`}
                  />
                );
              })}
            </Fragment>
          );
        })}
        <div />
        {Array.from({ length: cols }, (_, c) => (
          <div key={c} className="relative h-4">
            {c % tickEvery === 0 && <span className="absolute left-0 top-0.5 whitespace-nowrap text-[11px] text-muted">{time(new Date(start + c * step).toISOString())}</span>}
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-muted">
        <span>%0</span>
        <div className="flex">
          {RAMP.map((c) => <span key={c} className="h-2.5 w-6" style={{ background: c }} />)}
        </div>
        <span>%100 çalışıyor</span>
        <span className="ml-3 inline-block h-2.5 w-6 rounded-[2px]" style={{ backgroundImage: "repeating-linear-gradient(45deg, var(--surface-2) 0 4px, var(--grid) 4px 5px)" }} />
        <span>veri yok</span>
        {data.bottleneck_station !== null && <span className="ml-3">★ darboğaz adayı</span>}
        <span className="ml-3">Her hücre {duration(data.bucket_seconds)}</span>
      </div>
      {hover && (
        <div className="pointer-events-none absolute z-10" style={{ left: Math.min(hover.x + 12, 600), top: hover.y + 30 }}>
          <TooltipBox title={hover.title} rows={[{ label: "Çalışma oranı", value: pct(hover.ratio) }, { label: "Örnek", value: num(hover.samples) }]} />
        </div>
      )}
    </div>
  );
}

export function StationsTable({ data, pollMs }: { data: StationsResponse; pollMs: number }) {
  return (
    <Table>
      <thead>
        <tr>
          <th>İstasyon</th>
          <th>Tag</th>
          <th className="text-right">Çalışma oranı</th>
          <th className="text-right">Çalışma süresi (yaklaşık)</th>
          <th className="text-right">Örnek</th>
        </tr>
      </thead>
      <tbody className="tabular">
        {data.stations.map((s) => (
          <tr key={s.station}>
            <td className="font-medium">
              {stationLabel(s.station)} {s.station === data.bottleneck_station && <Badge tone="accent">darboğaz adayı</Badge>}
            </td>
            <td className="font-mono text-[12px]">{s.tag}</td>
            <td className="text-right">{s.run_ratio === null ? "veri yok" : pct(s.run_ratio)}</td>
            <td className="text-right">{duration(Math.round((s.run_ratio ?? 0) * s.samples * pollMs / 1000))}</td>
            <td className="text-right">{num(s.samples)}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
