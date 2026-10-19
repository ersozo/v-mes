import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { useState } from "react";
import { ChartCard } from "../components/ChartCard";
import { StatTile } from "../components/figures";
import { FilterBar, useReportFilters } from "../components/FilterBar";
import { CategoryTag } from "../components/state";
import { Dialog, PageHeader, Table } from "../components/ui";
import { COMPARISON_TYPES, Comparison, ComparisonTable, comparisonLegend, type ComparisonRow, type ComparisonType } from "../charts/Comparison";
import { Gantt, ganttLegend } from "../charts/Gantt";
import { HEATMAP_TYPES, Heatmap, type HeatmapType } from "../charts/Heatmap";
import { OeeTrend, TREND_TYPES, trendLegend, type TrendType } from "../charts/OeeTrend";
import { PARETO_TYPES, Pareto, ParetoTable, paretoLegend, type ParetoType } from "../charts/Pareto";
import { PRODUCTION_TYPES, Production, productionLegend, type ProductionType } from "../charts/Production";
import { WATERFALL_TYPES, Waterfall, waterfallLegend, type WaterfallType } from "../charts/Waterfall";
import { api } from "../lib/api";
import { dateTime, duration, num, pct, time } from "../lib/format";
import type { Downtime, OeeMetrics, OeeResponse, ParetoReason, ParetoResponse, ProductionResponse, TimelineResponse } from "../lib/types";
import { useUrlState } from "../lib/url-state";

function Delta({ now, prev }: { now: number | null | undefined; prev: number | null | undefined }) {
  if (now === null || now === undefined || prev === null || prev === undefined) return <span>Önceki dönem: —</span>;
  const d = (now - prev) * 100;
  const Icon = Math.abs(d) < 0.05 ? Minus : d > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={`inline-flex items-center gap-1 ${d > 0.05 ? "text-success" : d < -0.05 ? "text-danger" : ""}`}>
      <Icon className="size-3.5" aria-hidden />
      {d > 0 ? "+" : ""}
      {d.toLocaleString("tr-TR", { maximumFractionDigits: 1 })} puan önceki döneme göre
    </span>
  );
}

export function ReportsPage() {
  const f = useReportFilters();
  const [breakdownBy, setBreakdownBy] = useUrlState<"machine" | "line">("cmp", "machine");
  const [paretoPick, setParetoPick] = useState<ParetoReason | null>(null);

  const oee = useQuery({
    queryKey: ["oee", f.query, f.groupBy, breakdownBy],
    queryFn: () => api<OeeResponse>(`/api/oee?${f.query}&group_by=${f.groupBy}&breakdown=${breakdownBy}`),
  });
  const w = oee.data?.window;
  const spanMs = w ? new Date(w.to).getTime() - new Date(w.from).getTime() : 0;

  const prev = useQuery({
    queryKey: ["oee-prev", f.query, w?.from],
    enabled: f.compare && !!w,
    queryFn: () => {
      const to = w!.from;
      const from = new Date(new Date(w!.from).getTime() - spanMs).toISOString();
      const q = new URLSearchParams(f.query);
      q.delete("preset");
      q.set("from", from);
      q.set("to", to);
      return api<OeeResponse>(`/api/oee?${q}`);
    },
  });

  // Isı haritası: kısa aralıkta saat, uzunda gün
  const heatGroup = spanMs > 3 * 86_400_000 ? "day" : "hour";
  const heat = useQuery({
    queryKey: ["oee-heat", f.query, heatGroup],
    enabled: f.scope !== "machine",
    queryFn: () => api<OeeResponse>(`/api/oee?${f.query}&group_by=${heatGroup}&breakdown=machine`),
  });
  const pareto = useQuery({ queryKey: ["pareto", f.query], queryFn: () => api<ParetoResponse>(`/api/reports/downtime-pareto?${f.query}`) });
  const timeline = useQuery({
    queryKey: ["timeline", f.query],
    enabled: !!w && spanMs <= 7 * 86_400_000,
    queryFn: () => api<TimelineResponse>(`/api/reports/state-timeline?${f.query}`),
    retry: false,
  });
  const production = useQuery({
    queryKey: ["production", f.query, f.groupBy],
    queryFn: () => api<ProductionResponse>(`/api/reports/production?${f.query}&group_by=${f.groupBy}`),
  });

  const s = oee.data?.summary;
  const p = prev.data?.summary;
  const rows: ComparisonRow[] =
    breakdownBy === "line"
      ? (oee.data?.lines ?? []).map((l) => ({ ...l, key: l.line_id, name: l.line_name }))
      : (oee.data?.machines ?? []).map((m) => ({ ...m, key: m.machine_id, name: m.code }));

  const tile = (label: string, key: keyof Pick<OeeMetrics, "oee" | "availability" | "performance" | "quality">, sub: string, hero = false) => (
    <StatTile hero={hero} label={label} value={pct(s?.[key])} meter={s?.[key] ?? null} sub={f.compare ? <Delta now={s?.[key]} prev={p?.[key]} /> : sub} />
  );

  return (
    <div className="mx-auto max-w-[1600px]">
      <PageHeader title="Raporlar" subtitle={`${f.scopeLabel}${w ? ` · ${dateTime(w.from)} – ${dateTime(w.to)}` : ""}`} />
      <FilterBar f={f} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tile("OEE", "oee", "Kullanılabilirlik × Performans × Kalite", true)}
        {tile("Kullanılabilirlik", "availability", `Çalışma ${duration(s?.run_seconds)} / planlı ${duration(s?.planned_seconds)}`)}
        {tile("Performans", "performance", `${num(s?.total_count)} adet üretildi`)}
        {tile("Kalite", "quality", `${num(s?.scrap_count)} hurda`)}
      </div>

      {s && s.warnings.length > 0 && (
        <div className="mt-3 space-y-1 rounded-lg border border-line bg-surface p-3 text-[13px] text-ink-2" role="note">
          {s.warnings.map((m) => (
            <div key={m} className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--status-serious)]" aria-hidden />
              {m}
            </div>
          ))}
        </div>
      )}

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
        <ChartCard<TrendType>
          id="trend"
          className="xl:col-span-2"
          title="OEE trendi"
          subtitle={`Dönem: ${{ hour: "saatlik", shift: "vardiyalık", day: "günlük", week: "haftalık" }[f.groupBy]}`}
          types={TREND_TYPES}
          defaultType="line"
          loading={oee.isFetching}
          error={oee.error}
          empty={!oee.data?.series.length}
          csvPath={`/api/oee?${f.query}&group_by=${f.groupBy}&format=csv`}
          table={() => <SeriesTable data={oee.data?.series ?? []} />}
        >
          {(t) => (
            <>
              <div className="px-2 pb-1">{trendLegend(t)}</div>
              <OeeTrend data={oee.data?.series ?? []} type={t} />
            </>
          )}
        </ChartCard>

        <ChartCard<WaterfallType>
          id="losses"
          title="Kayıp şelalesi"
          subtitle="Planlı sürenin nereye gittiği"
          types={WATERFALL_TYPES}
          defaultType="waterfall"
          loading={oee.isFetching}
          error={oee.error}
          empty={!s || s.planned_seconds <= 0}
          emptyText="Seçilen aralıkta planlı üretim süresi yok"
          legend={waterfallLegend}
        >
          {(t) => s && <Waterfall metrics={s} type={t} />}
        </ChartCard>

        {f.scope !== "machine" && (
          <ChartCard<ComparisonType>
            id="compare"
            className="xl:col-span-2"
            title={breakdownBy === "line" ? "Hat karşılaştırması" : "Makine karşılaştırması"}
            subtitle={
              <button className="text-accent hover:underline" onClick={() => setBreakdownBy(breakdownBy === "line" ? "machine" : "line")}>
                {breakdownBy === "line" ? "Makine bazında göster" : "Hat bazında göster"}
              </button>
            }
            types={COMPARISON_TYPES}
            defaultType="bar"
            loading={oee.isFetching}
            error={oee.error}
            empty={!rows.length}
            csvPath={`/api/oee?${f.query}&group_by=none&breakdown=${breakdownBy}&format=csv`}
            table={() => <ComparisonTable rows={rows} />}
          >
            {(t, setT) => (
              <>
                <div className="px-2 pb-1">{comparisonLegend(t)}</div>
                <Comparison rows={rows} type={t} onTypeChange={setT} />
              </>
            )}
          </ChartCard>
        )}

        <ChartCard<ParetoType>
          id="pareto"
          className={f.scope === "machine" ? "xl:col-span-2" : ""}
          title="Duruş nedenleri"
          subtitle={pareto.data ? `Toplam ${duration(pareto.data.total_seconds)} · çubuğa tıklayın` : undefined}
          types={PARETO_TYPES}
          defaultType="bar"
          loading={pareto.isFetching}
          error={pareto.error}
          empty={!pareto.data?.reasons.length}
          emptyText="Bu aralıkta duruş yok"
          csvPath={`/api/reports/downtime-pareto?${f.query}&format=csv`}
          table={() => <ParetoTable reasons={pareto.data?.reasons ?? []} />}
          legend={pareto.data && paretoLegend(pareto.data.reasons)}
        >
          {(t) => <Pareto reasons={pareto.data?.reasons ?? []} type={t} onSelect={setParetoPick} />}
        </ChartCard>

        {f.scope !== "machine" && (
          <ChartCard<HeatmapType>
            id="heatmap"
            className="xl:col-span-3"
            title="OEE ısı haritası"
            subtitle={`Makine × ${heatGroup === "hour" ? "saat" : "gün"}`}
            types={HEATMAP_TYPES}
            defaultType="heatmap"
            loading={heat.isFetching}
            error={heat.error}
            empty={!heat.data?.series.length || !heat.data.series[0]?.machines?.length}
          >
            {(t) => <Heatmap series={heat.data?.series ?? []} type={t} />}
          </ChartCard>
        )}

        <ChartCard<"gantt">
          id="timeline"
          className="xl:col-span-3"
          title="Durum zaman çizelgesi"
          subtitle="Üst bant: makine durumu · alt şerit: duruş kayıtları"
          loading={timeline.isFetching}
          error={spanMs > 7 * 86_400_000 ? "Zaman çizelgesi en fazla 7 günlük aralık için gösterilir." : timeline.error}
          empty={!timeline.data?.machines.length}
          legend={ganttLegend}
        >
          {() => timeline.data && <Gantt data={timeline.data} />}
        </ChartCard>

        <ChartCard<ProductionType>
          id="production"
          className="xl:col-span-3"
          title="Üretim"
          subtitle={production.data ? `${num(production.data.totals.good_count)} iyi · ${num(production.data.totals.scrap_count)} hurda (planlı süre dışı dahil)` : undefined}
          types={PRODUCTION_TYPES}
          defaultType="column"
          loading={production.isFetching}
          error={production.error}
          empty={!production.data?.totals.total_count}
          emptyText="Bu aralıkta üretim yok"
          csvPath={`/api/reports/production?${f.query}&group_by=${f.groupBy}&format=csv`}
          table={() => (
            <Table>
              <thead>
                <tr>
                  <th>Dönem</th>
                  <th className="text-right">İyi</th>
                  <th className="text-right">Hurda</th>
                  <th className="text-right">Toplam</th>
                </tr>
              </thead>
              <tbody className="tabular">
                {production.data?.series.map((r) => (
                  <tr key={r.label}>
                    <td>{r.label}</td>
                    <td className="text-right">{num(r.good_count)}</td>
                    <td className="text-right">{num(r.scrap_count)}</td>
                    <td className="text-right">{num(r.total_count)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        >
          {(t) => (
            <>
              <div className="px-2 pb-1">{productionLegend(t)}</div>
              <Production data={production.data?.series ?? []} type={t} />
            </>
          )}
        </ChartCard>
      </div>

      <ParetoDrilldown reason={paretoPick} onClose={() => setParetoPick(null)} window={w} scope={f.scope} id={f.id} hierarchy={f.hierarchy} />
    </div>
  );
}

function SeriesTable({ data }: { data: OeeResponse["series"] }) {
  return (
    <Table>
      <thead>
        <tr>
          <th>Dönem</th>
          <th className="text-right">OEE</th>
          <th className="text-right">Kullanılabilirlik</th>
          <th className="text-right">Performans</th>
          <th className="text-right">Kalite</th>
          <th className="text-right">Adet</th>
        </tr>
      </thead>
      <tbody className="tabular">
        {data.map((r) => (
          <tr key={r.label}>
            <td>{r.label}</td>
            <td className="text-right">{pct(r.oee)}</td>
            <td className="text-right">{pct(r.availability)}</td>
            <td className="text-right">{pct(r.performance)}</td>
            <td className="text-right">{pct(r.quality)}</td>
            <td className="text-right">{num(r.total_count)}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/** Pareto çubuğuna tıklanınca: o nedene ait duruş kayıtları (detaya inme). */
function ParetoDrilldown({
  reason,
  onClose,
  window,
  scope,
  id,
  hierarchy,
}: {
  reason: ParetoReason | null;
  onClose: () => void;
  window?: { from: string; to: string };
  scope: string;
  id: number | null;
  hierarchy: { id: number; lines: { id: number; machines: { id: number }[] }[] }[];
}) {
  const params = new URLSearchParams({ limit: "500" });
  if (window) {
    params.set("from", window.from);
    params.set("to", window.to);
  }
  if (scope === "machine" && id) params.set("machine_id", String(id));
  if (scope === "line" && id) params.set("line_id", String(id));
  const list = useQuery({
    queryKey: ["drill", params.toString()],
    enabled: !!reason && !!window,
    queryFn: () => api<Downtime[]>(`/api/downtimes?${params}`),
  });
  const areaMachines = scope === "area" ? new Set(hierarchy.find((a) => a.id === id)?.lines.flatMap((l) => l.machines.map((m) => m.id))) : null;
  const rows = (list.data ?? []).filter((d) => d.reason_id === (reason?.reason_id ?? null) && (!areaMachines || areaMachines.has(d.machine_id)));

  return (
    <Dialog open={!!reason} onClose={onClose} title={reason ? `Duruşlar: ${reason.name}` : ""} wide>
      {reason && (
        <div className="mb-3">
          <CategoryTag category={reason.category} />
        </div>
      )}
      <Table>
        <thead>
          <tr>
            <th>Makine</th>
            <th>Başlangıç</th>
            <th>Bitiş</th>
            <th className="text-right">Süre</th>
            <th>Not</th>
          </tr>
        </thead>
        <tbody className="tabular">
          {rows.map((d) => (
            <tr key={d.id}>
              <td className="font-medium">{d.machine_code}</td>
              <td>{dateTime(d.start_ts)}</td>
              <td>{d.open ? "devam ediyor" : time(d.end_ts)}</td>
              <td className="text-right">{duration(d.duration_seconds)}</td>
              <td className="text-ink-2">{d.note ?? ""}</td>
            </tr>
          ))}
          {!list.isLoading && rows.length === 0 && (
            <tr>
              <td colSpan={5} className="text-center text-muted">
                Kayıt bulunamadı
              </td>
            </tr>
          )}
        </tbody>
      </Table>
    </Dialog>
  );
}
