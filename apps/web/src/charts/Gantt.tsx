// Durum zaman çizelgesi: makine başına durum bantları, altında duruş kayıtları, arka planda vardiya/planlı duruşlar.
import { useState } from "react";
import { CATEGORY_META, STATE_META } from "../components/state";
import { duration, time } from "../lib/format";
import type { TimelineResponse } from "../lib/types";
import { Legend, TooltipBox } from "./common";

export const ganttLegend = (
  <Legend
    items={[
      { color: STATE_META.running.color, label: STATE_META.running.label, shape: "square" },
      { color: STATE_META.stopped.color, label: STATE_META.stopped.label, shape: "square" },
      { color: STATE_META.offline.color, label: STATE_META.offline.label, shape: "square" },
      { color: CATEGORY_META.planned.color, label: "Planlı duruş / mola", shape: "square" },
    ]}
  />
);

export function Gantt({ data, onDowntimeClick }: { data: TimelineResponse; onDowntimeClick?: (id: number) => void }) {
  const [tip, setTip] = useState<{ x: number; y: number; rows: { color?: string; label: string; value: string }[]; title: string } | null>(null);
  const start = new Date(data.window.from).getTime();
  const end = Math.min(new Date(data.window.to).getTime(), Date.now());
  const span = Math.max(1, end - start);
  const pos = (iso: string) => ((new Date(iso).getTime() - start) / span) * 100;
  const width = (a: string, b: string) => Math.max(0.15, pos(b) - pos(a));

  // Zaman ekseni: yaklaşık 6–8 etiket
  const stepH = Math.max(1, Math.round(span / 3_600_000 / 7));
  const ticks: number[] = [];
  const first = Math.ceil(start / (stepH * 3_600_000)) * stepH * 3_600_000;
  for (let t = first; t <= end; t += stepH * 3_600_000) ticks.push(t);

  const show = (e: React.MouseEvent, title: string, rows: { color?: string; label: string; value: string }[]) => {
    const host = (e.currentTarget as HTMLElement).closest("[data-gantt]") as HTMLElement;
    const r = host.getBoundingClientRect();
    setTip({ x: e.clientX - r.left, y: e.clientY - r.top, title, rows });
  };

  return (
    <div className="relative px-3" data-gantt onMouseLeave={() => setTip(null)}>
      <div className="grid gap-y-3" style={{ gridTemplateColumns: "110px 1fr" }}>
        {data.machines.map((m) => (
          <div key={m.machine_id} className="contents">
            <div className="truncate pt-1 pr-2 text-[12px] text-ink-2">{m.code}</div>
            <div className="relative">
              {/* Planlı duruşlar (mola) arka plan şeridi */}
              <div className="relative h-6 overflow-hidden rounded bg-surface-2">
                {data.shifts.flatMap((s) => s.planned_stops).map((p) => (
                  <div key={p.from} className="absolute inset-y-0 opacity-30" style={{ left: `${pos(p.from)}%`, width: `${width(p.from, p.to)}%`, background: CATEGORY_META.planned.color }} />
                ))}
                {m.segments.map((s) => (
                  <div
                    key={s.from}
                    className="absolute inset-y-0.5 rounded-[2px]"
                    style={{ left: `calc(${pos(s.from)}% + 1px)`, width: `max(1px, calc(${width(s.from, s.to)}% - 2px))`, background: STATE_META[s.state].color }}
                    onMouseMove={(e) =>
                      show(e, STATE_META[s.state].label, [
                        { label: "Başlangıç", value: time(s.from) },
                        { label: "Bitiş", value: s.open ? "devam ediyor" : time(s.to) },
                        { label: "Süre", value: duration((new Date(s.to).getTime() - new Date(s.from).getTime()) / 1000) },
                      ])
                    }
                  />
                ))}
              </div>
              {/* Duruş kayıtları: ince şerit, kategori rengi; tıklanınca neden atama */}
              <div className="relative mt-0.5 h-2">
                {m.downtimes.map((d) => (
                  <button
                    key={d.id}
                    className="absolute inset-y-0 rounded-full"
                    style={{ left: `${pos(d.from)}%`, width: `max(4px, ${width(d.from, d.to)}%)`, background: CATEGORY_META[d.category].color }}
                    onClick={() => onDowntimeClick?.(d.id)}
                    onMouseMove={(e) =>
                      show(e, d.reason ?? "Nedeni girilmedi", [
                        { color: CATEGORY_META[d.category].color, label: CATEGORY_META[d.category].label, value: "" },
                        { label: "Zaman", value: `${time(d.from)}–${d.open ? "…" : time(d.to)}` },
                        { label: "Süre", value: duration((new Date(d.to).getTime() - new Date(d.from).getTime()) / 1000) },
                      ])
                    }
                    aria-label={`Duruş ${time(d.from)}: ${d.reason ?? "nedeni girilmedi"}`}
                  />
                ))}
              </div>
            </div>
          </div>
        ))}
        <div />
        <div className="relative h-5 border-t border-line">
          {ticks.map((t) => (
            <span key={t} className="tabular absolute top-1 -translate-x-1/2 text-[11px] text-muted" style={{ left: `${((t - start) / span) * 100}%` }}>
              {time(new Date(t).toISOString())}
            </span>
          ))}
        </div>
      </div>
      {tip && (
        <div className="pointer-events-none absolute z-10" style={{ left: tip.x + 12, top: tip.y + 12 }}>
          <TooltipBox title={tip.title} rows={tip.rows} />
        </div>
      )}
    </div>
  );
}
