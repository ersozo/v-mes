// Operatör ekranı (tablet): büyük dokunmatik hedefler, tek makineye sabitlenir.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Minus, Pause, Play, Plus, Timer, Trash2 } from "lucide-react";
import { useState } from "react";
import { AssignDowntimeDialog } from "../components/AssignDowntime";
import { Meter } from "../components/figures";
import { StateBadge } from "../components/state";
import { Button, Card, Dialog, Empty, ErrorBox, Input, Select, Spinner } from "../components/ui";
import { api } from "../lib/api";
import { clock, duration, num, since, time } from "../lib/format";
import { useNow } from "../lib/hooks";
import { useLive } from "../lib/live";
import type { Downtime, HierarchyArea, OperatorView, ProductionOrder } from "../lib/types";
import { readPref, writePref } from "../lib/url-state";

export function OperatorPage() {
  const hierarchy = useQuery({ queryKey: ["hierarchy"], queryFn: () => api<HierarchyArea[]>("/api/hierarchy") });
  const machines = (hierarchy.data ?? []).flatMap((a) => a.lines.flatMap((l) => l.machines.filter((m) => m.is_active)));
  const [machineId, setMachineId] = useState<number | null>(() => Number(readPref("operator-machine")) || null);
  const selected = machines.find((m) => m.id === machineId) ?? null;

  if (hierarchy.isLoading) return <Spinner />;
  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Operatör ekranı</h1>
        <Select
          aria-label="Makine"
          className="h-12 w-auto min-w-64 text-base"
          value={machineId ?? ""}
          onChange={(e) => {
            const v = Number(e.target.value) || null;
            setMachineId(v);
            writePref("operator-machine", String(v ?? ""));
          }}
        >
          <option value="">Makine seçin…</option>
          {machines.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} ({m.code})
            </option>
          ))}
        </Select>
      </div>
      {selected ? <MachinePanel machineId={selected.id} /> : <Card><Empty title="Bu tablette çalışacağınız makineyi seçin" /></Card>}
    </div>
  );
}

function MachinePanel({ machineId }: { machineId: number }) {
  const qc = useQueryClient();
  const now = useNow(1000);
  const live = useLive((s) => s.machines[machineId], machineId);
  const downtimeVersion = useLive((s) => s.downtimeVersion);
  const view = useQuery({
    queryKey: ["operator", machineId, downtimeVersion],
    queryFn: () => api<OperatorView>(`/api/operator/machines/${machineId}`),
    refetchInterval: 20_000,
  });
  const [assign, setAssign] = useState<Downtime | null>(null);
  const [confirm, setConfirm] = useState<ProductionOrder | null>(null);
  const [newOrder, setNewOrder] = useState(false);

  const action = useMutation({
    mutationFn: ({ id, verb }: { id: number; verb: "start" | "pause" | "complete" }) => api(`/api/production-orders/${id}/${verb}`, { method: "POST" }),
    onSuccess: () => {
      setConfirm(null);
      void qc.invalidateQueries();
    },
  });

  if (view.isLoading) return <Spinner />;
  if (view.error) return <ErrorBox error={view.error} onRetry={() => view.refetch()} />;
  const v = view.data!;
  const order = v.active_order;

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <div className="text-lg font-semibold">{v.machine.name}</div>
          <div className="text-muted">{v.machine.code}</div>
        </div>
        <div className="flex items-center gap-3">
          {live?.downtime_start && (
            <span className="inline-flex items-center gap-1.5 text-lg font-semibold">
              <Timer className="size-5 text-[var(--state-stopped)]" aria-hidden />
              <span className="tabular">{clock(since(live.downtime_start, now))}</span>
            </span>
          )}
          <StateBadge state={live?.state} size="lg" />
        </div>
      </Card>

      {action.error && <ErrorBox error={action.error} />}

      {v.unassigned_downtimes.length > 0 && (
        <Card className="p-4">
          <h2 className="mb-3 text-base font-semibold">Nedeni girilmemiş duruşlar</h2>
          <div className="space-y-2">
            {v.unassigned_downtimes.map((d) => (
              <div key={d.id} className="flex items-center justify-between gap-3 rounded-xl bg-surface-2 p-3">
                <div>
                  <div className="font-medium">
                    {time(d.start_ts)} – {d.open ? "devam ediyor" : time(d.end_ts)}
                  </div>
                  <div className="text-ink-2">{d.open ? clock(since(d.start_ts, now)) : duration(d.duration_seconds)}</div>
                </div>
                <Button size="lg" variant="primary" onClick={() => setAssign(d)}>
                  Neden gir
                </Button>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card className="p-5">
        {order ? (
          <>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <div className="text-[13px] text-muted">Çalışan iş emri</div>
                <div className="text-lg font-semibold">{order.order_no}</div>
                <div className="text-ink-2">{order.product_name}</div>
              </div>
              <div className="text-right">
                <div className="text-4xl font-semibold">
                  {num(order.good_qty)} <span className="text-xl text-muted">/ {num(order.target_qty)}</span>
                </div>
                <div className="text-[13px] text-ink-2">
                  {num(order.scrap_qty)} hurda{order.remaining_ideal_seconds !== null ? ` · ideal hızla kalan ${duration(order.remaining_ideal_seconds)}` : ""}
                </div>
              </div>
            </div>
            <div className="my-4">
              <Meter value={order.progress} tone="accent" label="İş emri ilerlemesi" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Button size="lg" icon={<Pause className="size-5" />} loading={action.isPending && action.variables?.verb === "pause"} onClick={() => action.mutate({ id: order.id, verb: "pause" })}>
                Duraklat
              </Button>
              <Button size="lg" variant="primary" icon={<CheckCircle2 className="size-5" />} onClick={() => setConfirm(order)}>
                Tamamla
              </Button>
            </div>
          </>
        ) : (
          <Empty title="Çalışan iş emri yok">Sıradaki bir iş emrini başlatın veya yeni bir iş emri oluşturun. İş emri olmadan yapılan üretimde performans hesaplanamaz.</Empty>
        )}
      </Card>

      <Card className="p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">Sıradaki iş emirleri</h2>
          <Button icon={<Plus className="size-4" />} onClick={() => setNewOrder(true)}>
            Yeni iş emri
          </Button>
        </div>
        {v.queue.length === 0 ? (
          <p className="text-muted">Sırada iş emri yok.</p>
        ) : (
          <div className="space-y-2">
            {v.queue.map((o) => (
              <div key={o.id} className="flex items-center justify-between gap-3 rounded-xl border border-line p-3">
                <div className="min-w-0">
                  <div className="font-medium">
                    {o.order_no} {o.status === "paused" && <span className="text-[12px] text-muted">· duraklatıldı</span>}
                  </div>
                  <div className="truncate text-ink-2">
                    {o.product_name} · {num(o.good_qty)} / {num(o.target_qty)}
                  </div>
                </div>
                <Button size="lg" icon={<Play className="size-5" />} disabled={!!order} title={order ? "Önce çalışan iş emrini duraklatın veya tamamlayın" : undefined}
                  loading={action.isPending && action.variables?.id === o.id} onClick={() => action.mutate({ id: o.id, verb: "start" })}>
                  {o.status === "paused" ? "Devam" : "Başlat"}
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>

      <ScrapEntry machineId={machineId} manual={v.machine.scrap_source === "manual"} />

      <AssignDowntimeDialog downtime={assign} onClose={() => setAssign(null)} />
      <Dialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title="İş emrini tamamla"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Vazgeç
            </Button>
            <Button variant="primary" size="lg" loading={action.isPending} onClick={() => confirm && action.mutate({ id: confirm.id, verb: "complete" })}>
              Tamamla
            </Button>
          </>
        }
      >
        {confirm && (
          <p>
            <span className="font-medium">{confirm.order_no}</span> tamamlanacak: {num(confirm.good_qty)} iyi / {num(confirm.target_qty)} hedef. Tamamlanan iş emri yeniden başlatılamaz.
          </p>
        )}
      </Dialog>
      <NewOrderDialog open={newOrder} onClose={() => setNewOrder(false)} machineId={machineId} />
    </div>
  );
}

function ScrapEntry({ machineId, manual }: { machineId: number; manual: boolean }) {
  const qc = useQueryClient();
  const [qty, setQty] = useState(1);
  const [reason, setReason] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api("/api/scrap", { method: "POST", json: { machine_id: machineId, qty, reason: reason || null } }),
    onSuccess: () => {
      setDone(`${qty} adet hurda kaydedildi`);
      setQty(1);
      setReason("");
      void qc.invalidateQueries({ queryKey: ["operator"] });
      setTimeout(() => setDone(null), 4000);
    },
  });
  if (!manual) {
    return <p className="px-1 text-[13px] text-muted">Bu makinede hurda adedi PLC sayacından okunuyor.</p>;
  }
  return (
    <Card className="p-4">
      <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
        <Trash2 className="size-4 text-muted" /> Hurda girişi
      </h2>
      {save.error && <ErrorBox error={save.error} />}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Button size="lg" aria-label="Azalt" onClick={() => setQty((q) => Math.max(1, q - 1))}>
            <Minus className="size-5" />
          </Button>
          <Input type="number" min={1} value={qty} onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))} className="h-14 w-24 text-center text-xl font-semibold" aria-label="Adet" />
          <Button size="lg" aria-label="Artır" onClick={() => setQty((q) => q + 1)}>
            <Plus className="size-5" />
          </Button>
        </div>
        <Input placeholder="Neden (isteğe bağlı)" value={reason} onChange={(e) => setReason(e.target.value)} className="h-14 min-w-48 flex-1" maxLength={200} />
        <Button size="lg" variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
          Kaydet
        </Button>
      </div>
      {done && <p className="mt-2 text-success" role="status">{done}</p>}
    </Card>
  );
}

export function NewOrderDialog({ open, onClose, machineId }: { open: boolean; onClose: () => void; machineId?: number }) {
  const qc = useQueryClient();
  const products = useQuery({ queryKey: ["products"], queryFn: () => api<{ id: number; code: string; name: string; is_active: boolean }[]>("/api/products"), enabled: open });
  const hierarchy = useQuery({ queryKey: ["hierarchy"], queryFn: () => api<HierarchyArea[]>("/api/hierarchy"), enabled: open });
  const machines = (hierarchy.data ?? []).flatMap((a) => a.lines.flatMap((l) => l.machines.filter((m) => m.is_active)));
  const [form, setForm] = useState({ order_no: "", product_id: "", machine_id: machineId ? String(machineId) : "", target_qty: "" });
  const save = useMutation({
    mutationFn: () =>
      api("/api/production-orders", {
        method: "POST",
        json: { order_no: form.order_no, product_id: Number(form.product_id), machine_id: Number(form.machine_id || machineId), target_qty: Number(form.target_qty) },
      }),
    onSuccess: () => {
      void qc.invalidateQueries();
      setForm({ order_no: "", product_id: "", machine_id: machineId ? String(machineId) : "", target_qty: "" });
      onClose();
    },
  });
  const valid = form.order_no && form.product_id && (form.machine_id || machineId) && Number(form.target_qty) > 0;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Yeni iş emri"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Vazgeç
          </Button>
          <Button variant="primary" disabled={!valid} loading={save.isPending} onClick={() => save.mutate()}>
            Oluştur
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {save.error && <ErrorBox error={save.error} />}
        <Input placeholder="İş emri no (ör. IE-2026-0042)" value={form.order_no} onChange={(e) => setForm({ ...form, order_no: e.target.value })} aria-label="İş emri no" />
        <Select aria-label="Ürün" value={form.product_id} onChange={(e) => setForm({ ...form, product_id: e.target.value })}>
          <option value="">Ürün seçin…</option>
          {(products.data ?? []).filter((p) => p.is_active).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.code})
            </option>
          ))}
        </Select>
        {!machineId && (
          <Select aria-label="Makine" value={form.machine_id} onChange={(e) => setForm({ ...form, machine_id: e.target.value })}>
            <option value="">Makine seçin…</option>
            {machines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.code})
              </option>
            ))}
          </Select>
        )}
        <Input type="number" min={1} placeholder="Hedef adet" value={form.target_qty} onChange={(e) => setForm({ ...form, target_qty: e.target.value })} aria-label="Hedef adet" />
      </div>
    </Dialog>
  );
}
