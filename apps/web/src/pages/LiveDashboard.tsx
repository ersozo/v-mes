import { useQuery } from "@tanstack/react-query";
import { Gauge, Timer } from "lucide-react";
import { Link } from "react-router";
import { Meter, StatTile } from "../components/figures";
import { STATE_META, StateBadge } from "../components/state";
import { Card, Empty, ErrorBox, PageHeader, Spinner } from "../components/ui";
import { api } from "../lib/api";
import { clock, duration, num, pct, since, time } from "../lib/format";
import { useNow } from "../lib/hooks";
import { ratePerMinute, useLive, type LiveMachine } from "../lib/live";
import type { HierarchyArea, LiveOee, Machine, ProductionOrder } from "../lib/types";

export function LiveDashboard() {
  const hierarchy = useQuery({ queryKey: ["hierarchy"], queryFn: () => api<HierarchyArea[]>("/api/hierarchy") });
  const live = useQuery({ queryKey: ["oee-live"], queryFn: () => api<LiveOee>("/api/oee/live"), refetchInterval: 30_000 });
  const orders = useQuery({
    queryKey: ["orders", "running"],
    queryFn: () => api<ProductionOrder[]>("/api/production-orders?status=running"),
    refetchInterval: 30_000,
  });
  const machinesLive = useLive((s) => s.machines);

  if (hierarchy.isLoading) return <Spinner />;
  if (hierarchy.error) return <ErrorBox error={hierarchy.error} onRetry={() => hierarchy.refetch()} />;

  const all = (hierarchy.data ?? []).flatMap((a) => a.lines.flatMap((l) => l.machines)).filter((m) => m.is_active);
  const counts = { running: 0, stopped: 0, offline: 0 };
  for (const m of all) {
    const st = machinesLive[m.id]?.state;
    if (st) counts[st]++;
    else counts.offline++;
  }
  const oeeById = new Map(live.data?.machines.map((m) => [m.machine_id, m]));
  const orderByMachine = new Map(orders.data?.map((o) => [o.machine_id, o]));
  const w = live.data?.window;

  return (
    <div className="mx-auto max-w-[1600px]">
      <PageHeader title="Canlı panel" subtitle={w ? `${w.label} · ${time(w.from)}–${time(w.to)}` : "Vardiya bilgisi yükleniyor"} />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile className="col-span-2" hero label="Vardiya OEE" value={pct(live.data?.summary.oee)} meter={live.data?.summary.oee ?? null}
          sub={
            live.data && live.data.summary.oee === null && live.data.summary.unattributed_count > 0
              ? `${num(live.data.summary.unattributed_count)} adet iş emri olmadan üretildi; performans ve OEE hesaplanamıyor`
              : `${num(live.data?.summary.total_count)} adet · ${all.length} makine`
          } />
        {(["running", "stopped", "offline"] as const).map((s) => (
          <StatTile
            key={s}
            label={STATE_META[s].label}
            value={
              <span className="inline-flex items-center gap-2">
                <span className="state-dot inline-flex [&_svg]:size-5" style={{ color: STATE_META[s].color }}>
                  {STATE_META[s].icon}
                </span>
                {counts[s]}
              </span>
            }
            sub="makine"
          />
        ))}
      </div>

      {all.length === 0 ? (
        <Card>
          <Empty title="Henüz makine tanımlanmamış" icon={<Gauge className="size-8" />}>
            PLC konfigüratöründen alan, hat ve makine ekleyin.
          </Empty>
        </Card>
      ) : (
        (hierarchy.data ?? []).map((area) => (
          <section key={area.id} className="mb-8">
            <h2 className="mb-3 text-[13px] font-semibold tracking-wide text-muted uppercase">{area.name}</h2>
            {area.lines.map((line) => {
              const machines = line.machines.filter((m) => m.is_active);
              if (!machines.length) return null;
              return (
                <div key={line.id} className="mb-5">
                  <h3 className="mb-2 font-medium text-ink-2">{line.name}</h3>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                    {machines.map((m) => (
                      <MachineCard key={m.id} machine={m} live={machinesLive[m.id]} oee={oeeById.get(m.id)} order={orderByMachine.get(m.id)} />
                    ))}
                  </div>
                </div>
              );
            })}
          </section>
        ))
      )}
    </div>
  );
}

function MachineCard({ machine, live, oee, order }: { machine: Machine; live: LiveMachine | undefined; oee: LiveOee["machines"][number] | undefined; order?: ProductionOrder }) {
  const now = useNow(1000);
  const state = live?.state ?? null;
  const rate = ratePerMinute(live);
  const downtimeFor = live?.downtime_start ? since(live.downtime_start, now) : null;

  return (
    <Link to={`/machines/${machine.id}`} className="group block rounded-xl focus-visible:outline-offset-4">
      <Card className="relative overflow-hidden p-4 transition-colors group-hover:bg-surface-2">
        {/* Durum şeridi: renk + rozet (ikon ve etiket) birlikte */}
        <div className="absolute inset-y-0 left-0 w-1" style={{ background: STATE_META[state ?? "unknown"].color }} aria-hidden />
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate font-semibold">{machine.name}</div>
            <div className="text-[12px] text-muted">{machine.code}</div>
          </div>
          <StateBadge state={state} />
        </div>

        <div className="mt-1 text-[12px] text-ink-2">{live?.since ? `${duration(since(live.since, now))} süredir` : "Durum bekleniyor"}</div>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <div>
            <div className="text-[12px] text-muted">Vardiya OEE</div>
            <div className="text-xl font-semibold">{pct(oee?.oee)}</div>
            <Meter value={oee?.oee} label={`${machine.name} vardiya OEE`} />
            {oee && oee.oee === null && oee.unattributed_count > 0 && (
              <div className="mt-1 text-[11px] text-muted" title="Bu vardiyada iş emri olmadan üretim yapıldı; ideal hız bilinmediği için performans hesaplanamıyor.">
                İş emrisiz üretim var
              </div>
            )}
          </div>
          <div>
            <div className="text-[12px] text-muted">Anlık hız</div>
            <div className="text-xl font-semibold">
              {rate === null ? <span className="text-[13px] font-normal text-muted">{state === "running" ? "ölçülüyor…" : "—"}</span> : <>{num(rate, 1)} <span className="text-[12px] font-normal text-muted">adet/dk</span></>}
            </div>
          </div>
        </div>

        {downtimeFor !== null && (
          <div className="mt-3 flex items-center gap-2 rounded-lg bg-surface-2 px-2.5 py-1.5 text-[13px]">
            <Timer className="size-4 text-[var(--state-stopped)]" aria-hidden />
            <span className="tabular font-medium">{clock(downtimeFor)}</span>
            <span className="text-ink-2">duruş</span>
          </div>
        )}

        <div className="mt-3 border-t border-line pt-3 text-[13px]">
          {order ? (
            <>
              <div className="flex justify-between gap-2">
                <span className="truncate text-ink-2">
                  {order.order_no} · {order.product_name}
                </span>
                <span className="tabular shrink-0 font-medium">
                  {num(order.good_qty)} / {num(order.target_qty)}
                </span>
              </div>
              <div className="mt-1.5">
                <Meter value={order.progress} tone="accent" label="İş emri ilerlemesi" />
              </div>
            </>
          ) : (
            <span className="text-muted">Çalışan iş emri yok</span>
          )}
        </div>
      </Card>
    </Link>
  );
}
