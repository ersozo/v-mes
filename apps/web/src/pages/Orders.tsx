import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { Meter } from "../components/figures";
import { Badge, Button, Card, Empty, ErrorBox, PageHeader, Segmented, Spinner, Table } from "../components/ui";
import { api } from "../lib/api";
import { can, useAuth } from "../lib/auth";
import { dateTime, num, pct } from "../lib/format";
import type { OrderStatus, ProductionOrder } from "../lib/types";
import { useUrlState } from "../lib/url-state";
import { NewOrderDialog } from "./Operator";

const STATUS: Record<OrderStatus, { label: string; tone: "neutral" | "good" | "warning" | "accent" | "critical" }> = {
  running: { label: "Çalışıyor", tone: "good" },
  paused: { label: "Duraklatıldı", tone: "warning" },
  planned: { label: "Planlandı", tone: "accent" },
  done: { label: "Tamamlandı", tone: "neutral" },
  cancelled: { label: "İptal", tone: "neutral" },
};

export function OrdersPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [filter, setFilter] = useUrlState<"open" | "closed" | "all">("filter", "open");
  const [creating, setCreating] = useState(false);
  const statuses = filter === "open" ? "status=running&status=paused&status=planned" : filter === "closed" ? "status=done&status=cancelled" : "";
  const orders = useQuery({ queryKey: ["orders", filter], queryFn: () => api<ProductionOrder[]>(`/api/production-orders?${statuses}&limit=500`), refetchInterval: 30_000 });
  const action = useMutation({
    mutationFn: ({ id, verb }: { id: number; verb: string }) => api(`/api/production-orders/${id}/${verb}`, { method: "POST" }),
    onSuccess: () => void qc.invalidateQueries(),
  });
  const operate = can(user, "operate");

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader
        title="İş emirleri"
        actions={
          <>
            <Segmented label="Filtre" value={filter} onChange={setFilter} options={[{ value: "open", label: "Açık" }, { value: "closed", label: "Kapanmış" }, { value: "all", label: "Tümü" }]} />
            {operate && (
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
                Yeni iş emri
              </Button>
            )}
          </>
        }
      />
      {action.error && <div className="mb-3"><ErrorBox error={action.error} /></div>}
      <Card>
        {orders.isLoading ? (
          <Spinner />
        ) : orders.error ? (
          <div className="p-4"><ErrorBox error={orders.error} /></div>
        ) : !orders.data?.length ? (
          <Empty title="İş emri yok" />
        ) : (
          <Table>
            <thead>
              <tr>
                <th>İş emri</th>
                <th>Makine</th>
                <th>Ürün</th>
                <th>Durum</th>
                <th className="w-48">İlerleme</th>
                <th className="text-right">Hurda</th>
                <th>Başlangıç</th>
                <th />
              </tr>
            </thead>
            <tbody className="tabular">
              {orders.data.map((o) => (
                <tr key={o.id}>
                  <td className="font-medium">{o.order_no}</td>
                  <td>{o.machine_code}</td>
                  <td className="text-ink-2">{o.product_name}</td>
                  <td><Badge tone={STATUS[o.status].tone}>{STATUS[o.status].label}</Badge></td>
                  <td>
                    <div className="flex items-center justify-between text-[12px]">
                      <span>{num(o.good_qty)} / {num(o.target_qty)}</span>
                      <span className="text-muted">{pct(o.progress, 0)}</span>
                    </div>
                    <Meter value={o.progress} tone="accent" label={`${o.order_no} ilerleme`} />
                  </td>
                  <td className="text-right">{num(o.scrap_qty)}</td>
                  <td className="text-ink-2">{dateTime(o.started_at)}</td>
                  <td className="text-right whitespace-nowrap">
                    {operate && (
                      <span className="inline-flex gap-1">
                        {(o.status === "planned" || o.status === "paused") && <Button size="sm" onClick={() => action.mutate({ id: o.id, verb: "start" })}>{o.status === "paused" ? "Devam" : "Başlat"}</Button>}
                        {o.status === "running" && <Button size="sm" onClick={() => action.mutate({ id: o.id, verb: "pause" })}>Duraklat</Button>}
                        {(o.status === "running" || o.status === "paused") && <Button size="sm" onClick={() => action.mutate({ id: o.id, verb: "complete" })}>Tamamla</Button>}
                        {(o.status === "planned" || o.status === "paused") && <Button size="sm" variant="ghost" onClick={() => action.mutate({ id: o.id, verb: "cancel" })}>İptal</Button>}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <NewOrderDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}
