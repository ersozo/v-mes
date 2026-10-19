import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Tag as TagIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { AssignDowntimeDialog } from "../components/AssignDowntime";
import { ChartCard } from "../components/ChartCard";
import { OeeTiles } from "../components/figures";
import { CategoryTag, StateBadge } from "../components/state";
import { Button, Card, ErrorBox, PageHeader, Spinner, Table } from "../components/ui";
import { Gantt, ganttLegend } from "../charts/Gantt";
import { TELEMETRY_TYPES, TelemetryChart, type TelemetryPoint, type TelemetryType } from "../charts/Telemetry";
import { api } from "../lib/api";
import { can, useAuth } from "../lib/auth";
import { dateTime, duration, num, since, time } from "../lib/format";
import { useNow } from "../lib/hooks";
import { ratePerMinute, useLive } from "../lib/live";
import type { Downtime, LiveOee, MachineDetail, TelemetryResponse, TimelineResponse } from "../lib/types";

export function MachineDetailPage() {
  const id = Number(useParams().id);
  const { user } = useAuth();
  const now = useNow(1000);
  const [assign, setAssign] = useState<Downtime | null>(null);
  const machine = useQuery({ queryKey: ["machine", id], queryFn: () => api<MachineDetail>(`/api/machines/${id}`) });
  const live = useLive((s) => s.machines[id], id);
  const downtimeVersion = useLive((s) => s.downtimeVersion);
  const oee = useQuery({ queryKey: ["oee-live", "machine", id], queryFn: () => api<LiveOee>(`/api/oee/live?scope=machine&id=${id}`), refetchInterval: 30_000 });
  const timeline = useQuery({
    queryKey: ["timeline", "machine", id, downtimeVersion],
    queryFn: () => api<TimelineResponse>(`/api/reports/state-timeline?scope=machine&id=${id}&preset=today`),
    refetchInterval: 60_000,
  });
  const downtimes = useQuery({
    queryKey: ["downtimes", id, downtimeVersion],
    queryFn: () => api<Downtime[]>(`/api/downtimes?machine_id=${id}&limit=20`),
  });

  if (machine.isLoading) return <Spinner />;
  if (machine.error) return <ErrorBox error={machine.error} />;
  const m = machine.data!;
  const processTags = (m.plc?.tags ?? []).filter((t) => t.role === "process");
  const rate = ratePerMinute(live);

  return (
    <div className="mx-auto max-w-[1400px]">
      <Link to="/" className="mb-3 inline-flex items-center gap-1 text-[13px] text-ink-2 hover:text-ink">
        <ArrowLeft className="size-4" /> Canlı panel
      </Link>
      <PageHeader
        title={m.name}
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-2">
            <span className="text-muted">{m.code}</span>
            <StateBadge state={live?.state} />
            {live?.since && <span>{duration(since(live.since, now))} süredir</span>}
            {rate !== null && <span>· {num(rate, 1)} adet/dk</span>}
          </span>
        }
      />

      <div className="mb-1 text-[13px] text-muted">{oee.data ? `${oee.data.window.label} (${time(oee.data.window.from)}–${time(oee.data.window.to)})` : "Vardiya"}</div>
      <OeeTiles m={oee.data?.summary} />

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="p-4">
          <h3 className="mb-3 flex items-center gap-2 font-semibold">
            <TagIcon className="size-4 text-muted" /> Canlı değerler
          </h3>
          <dl className="divide-y divide-line">
            {(m.plc?.tags ?? []).map((t) => {
              const v = live?.tags[t.name];
              return (
                <div key={t.name} className="flex items-baseline justify-between gap-3 py-1.5">
                  <dt className="text-ink-2">
                    {t.name} <span className="text-[11px] text-muted">{t.address}</span>
                  </dt>
                  <dd className="tabular font-medium">
                    {v === undefined ? "—" : t.role === "running" ? (v ? "evet" : "hayır") : num(v, t.role === "process" ? 1 : 0)}
                    {t.unit && v !== undefined && t.role !== "running" ? <span className="ml-1 text-[12px] font-normal text-muted">{t.unit}</span> : null}
                  </dd>
                </div>
              );
            })}
          </dl>
          <p className="mt-2 text-[12px] text-muted">Son okuma: {live?.tags_ts ? time(live.tags_ts) + ":" + new Date(live.tags_ts).getSeconds().toString().padStart(2, "0") : "—"}</p>
        </Card>

        <div className="space-y-4 lg:col-span-2">
          {processTags.map((t, i) => (
            <ProcessTagChart key={t.name} machineId={id} tag={t.name} unit={t.unit} colorIndex={i} liveValue={live?.tags[t.name]} liveTs={live?.tags_ts ?? null} />
          ))}
        </div>
      </div>

      <div className="mt-4">
        <ChartCard id="m-timeline" title="Bugünkü durum geçmişi" loading={timeline.isFetching} error={timeline.error} empty={!timeline.data?.machines.length} legend={ganttLegend}>
          {() =>
            timeline.data && (
              <Gantt data={timeline.data} onDowntimeClick={(dtId) => can(user, "operate") && setAssign(downtimes.data?.find((d) => d.id === dtId) ?? null)} />
            )
          }
        </ChartCard>
      </div>

      <Card className="mt-4 p-4">
        <h3 className="mb-2 font-semibold">Son duruşlar</h3>
        <Table>
          <thead>
            <tr>
              <th>Başlangıç</th>
              <th className="text-right">Süre</th>
              <th>Neden</th>
              <th>Not</th>
              <th />
            </tr>
          </thead>
          <tbody className="tabular">
            {(downtimes.data ?? []).map((d) => (
              <tr key={d.id}>
                <td>{dateTime(d.start_ts)}</td>
                <td className="text-right">{d.open ? <span className="font-medium">{duration(since(d.start_ts, now))} · devam ediyor</span> : duration(d.duration_seconds)}</td>
                <td>{d.reason_name ? <span className="font-medium">{d.reason_name}</span> : <CategoryTag category="unassigned" />}</td>
                <td className="text-ink-2">{d.note ?? ""}</td>
                <td className="text-right">
                  {can(user, "operate") && (
                    <Button size="sm" variant={d.reason_id ? "ghost" : "secondary"} onClick={() => setAssign(d)}>
                      {d.reason_id ? "Değiştir" : "Neden gir"}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>

      <AssignDowntimeDialog downtime={assign} onClose={() => setAssign(null)} />
    </div>
  );
}

/** Son 1 saatin geçmişi + canlı değerlerin eklenmesi. */
function ProcessTagChart({ machineId, tag, unit, colorIndex, liveValue, liveTs }: { machineId: number; tag: string; unit?: string | null; colorIndex: number; liveValue?: number; liveTs: string | null }) {
  const history = useQuery({
    queryKey: ["telemetry", machineId, tag],
    queryFn: () => {
      const q = new URLSearchParams({
        machine_id: String(machineId),
        tags: tag,
        from: new Date(Date.now() - 3_600_000).toISOString(),
        to: new Date().toISOString(),
        max_points: "720",
      });
      return api<TelemetryResponse>(`/api/telemetry?${q}`);
    },
    staleTime: Infinity,
  });
  const liveRef = useRef<TelemetryPoint[]>([]);
  const [, bump] = useState(0);
  useEffect(() => {
    if (liveValue === undefined || !liveTs) return;
    const t = new Date(liveTs).getTime();
    const arr = liveRef.current;
    if (arr.length && arr[arr.length - 1]!.t >= t) return;
    arr.push({ t, avg: liveValue, min: liveValue, max: liveValue });
    const cutoff = Date.now() - 3_600_000;
    while (arr.length && arr[0]!.t < cutoff) arr.shift();
    bump((x) => x + 1);
  }, [liveValue, liveTs]);

  const points = useMemo(() => {
    const hist = (history.data?.series[tag] ?? []).map((p) => ({ t: new Date(p.ts).getTime(), avg: p.avg, min: p.min, max: p.max }));
    const lastHist = hist.length ? hist[hist.length - 1]!.t : 0;
    return [...hist, ...liveRef.current.filter((p) => p.t > lastHist)];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history.data, tag, liveRef.current.length]);

  return (
    <ChartCard<TelemetryType>
      id={`tel-${tag}`}
      title={tag}
      subtitle={`Son 1 saat${unit ? ` · ${unit}` : ""} · canlı`}
      types={TELEMETRY_TYPES}
      defaultType="line"
      loading={history.isLoading}
      error={history.error}
      empty={points.length === 0}
    >
      {(t) => <TelemetryChart points={points} type={t} unit={unit} colorIndex={colorIndex} />}
    </ChartCard>
  );
}
