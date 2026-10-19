// Edge cihazları (makine başına HUBBOX içindeki Node-RED): kayıt, uyumluluk kontrolü, canlı durum.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Clock, Plus, Router, Stethoscope, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge, Button, Card, Checkbox, Dialog, Empty, ErrorBox, Field, Input, PageHeader, Spinner, Table } from "../components/ui";
import { api } from "../lib/api";
import { useLive } from "../lib/live";
import type { Edge, EdgeCheck } from "../lib/types";

export function EdgesPage() {
  const edges = useQuery({ queryKey: ["edges"], queryFn: () => api<Edge[]>("/api/edges") });
  const online = useLive((s) => s.edges);
  const skew = useLive((s) => s.edgeSkew);
  const [edit, setEdit] = useState<Edge | "new" | null>(null);
  const [checkFor, setCheckFor] = useState<Edge | null>(null);

  return (
    <div className="mx-auto max-w-[1200px]">
      <PageHeader
        title="Edge cihazları"
        subtitle="Makinelerin PLC'lerini okuyan gateway'ler (HUBBOX içindeki Node-RED). Akışlar her edge'e ayrı dağıtılır."
        actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEdit("new")}>Edge ekle</Button>}
      />
      <Card>
        {edges.isLoading ? <Spinner /> : edges.error ? <div className="p-4"><ErrorBox error={edges.error} /></div> : !edges.data?.length ? (
          <Empty title="Henüz edge tanımlanmamış" icon={<Router className="size-8" />}>Her makinenin HUBBOX'ını Node-RED adresiyle ekleyin.</Empty>
        ) : (
          <Table>
            <thead>
              <tr><th>Kod</th><th>Ad</th><th>Node-RED</th><th>Durum</th><th>Saat</th><th>Makineler</th><th /></tr>
            </thead>
            <tbody>
              {edges.data.map((e) => {
                const on = online[e.code];
                const sk = skew[e.code];
                return (
                  <tr key={e.id} className={e.is_active ? "" : "opacity-60"}>
                    <td className="font-mono font-medium">{e.code}</td>
                    <td>{e.name}</td>
                    <td className="font-mono text-[12px] text-ink-2">{e.nodered_url}</td>
                    <td>
                      {!e.is_active ? <Badge>Pasif</Badge> : on === undefined ? <Badge>Sinyal yok</Badge> : on
                        ? <Badge tone="good"><CheckCircle2 className="size-3.5" /> Çevrimiçi</Badge>
                        : <Badge tone="critical"><XCircle className="size-3.5" /> Erişilemiyor</Badge>}
                    </td>
                    <td className="tabular">
                      {sk === undefined || sk === null ? <span className="text-muted">—</span> : Math.abs(sk) > 30
                        ? <span className="inline-flex items-center gap-1 text-danger"><AlertTriangle className="size-3.5" />{sk > 0 ? "−" : "+"}{Math.abs(sk)} sn</span>
                        : <span className="inline-flex items-center gap-1 text-ink-2"><Clock className="size-3.5" />senkron</span>}
                    </td>
                    <td className="text-ink-2">{e.machines.join(", ") || "—"}</td>
                    <td className="text-right whitespace-nowrap">
                      <Button size="sm" variant="ghost" icon={<Stethoscope className="size-4" />} onClick={() => setCheckFor(e)}>Kontrol</Button>
                      <Button size="sm" onClick={() => setEdit(e)}>Düzenle</Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
      <p className="mt-3 text-[12px] text-muted">
        Node-RED kullanıcı adı/şifresi tüm edge'ler için ortaktır ve sunucunun <code>.env</code> dosyasında tutulur (EDGE_NODERED_USER / EDGE_NODERED_PASSWORD). Edge'in saati NTP ile senkron olmalıdır.
      </p>
      <EdgeDialog edge={edit} onClose={() => setEdit(null)} />
      <CheckDialog edge={checkFor} onClose={() => setCheckFor(null)} />
    </div>
  );
}

function EdgeDialog({ edge, onClose }: { edge: Edge | "new" | null; onClose: () => void }) {
  const qc = useQueryClient();
  const e = edge && edge !== "new" ? edge : null;
  const [form, setForm] = useState({ code: "", name: "", nodered_url: "http://", is_active: true, notes: "" });
  useEffect(() => {
    setForm({ code: e?.code ?? "", name: e?.name ?? "", nodered_url: e?.nodered_url ?? "http://", is_active: e?.is_active ?? true, notes: e?.notes ?? "" });
  }, [edge]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useMutation({
    mutationFn: () => {
      const body = { ...form, notes: form.notes || null };
      return e ? api(`/api/edges/${e.id}`, { method: "PATCH", json: { name: body.name, nodered_url: body.nodered_url, is_active: body.is_active, notes: body.notes } }) : api("/api/edges", { method: "POST", json: body });
    },
    onSuccess: () => { void qc.invalidateQueries(); onClose(); },
  });
  const del = useMutation({ mutationFn: () => api(`/api/edges/${e!.id}`, { method: "DELETE" }), onSuccess: () => { void qc.invalidateQueries(); onClose(); } });
  return (
    <Dialog open={!!edge} onClose={onClose} title={e ? `Edge: ${e.code}` : "Yeni edge"}
      footer={<>{e && <Button variant="danger" className="mr-auto" loading={del.isPending} onClick={() => del.mutate()} disabled={e.machine_count > 0} title={e.machine_count > 0 ? "Makine atanmış edge silinemez" : undefined}>Sil</Button>}
        <Button variant="ghost" onClick={onClose}>Vazgeç</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Kaydet</Button></>}>
      <div className="space-y-4">
        {(save.error || del.error) && <ErrorBox error={save.error || del.error} />}
        <div className="grid grid-cols-2 gap-4">
          <Field label="Kod" hint={e ? "Kod değiştirilemez" : "küçük harf, rakam, tire — ör. hubbox-mekanik"}>
            {(id) => <Input id={id} value={form.code} disabled={!!e} onChange={(ev) => setForm({ ...form, code: ev.target.value })} />}
          </Field>
          <Field label="Ad">{(id) => <Input id={id} value={form.name} placeholder="Mekanik HUBBOX" onChange={(ev) => setForm({ ...form, name: ev.target.value })} />}</Field>
        </div>
        <Field label="Node-RED adresi" hint="Sunucudan erişilebilen adres, ör. http://10.146.168.19:1880">
          {(id) => <Input id={id} className="font-mono" value={form.nodered_url} onChange={(ev) => setForm({ ...form, nodered_url: ev.target.value })} />}
        </Field>
        <Field label="Not">{(id) => <Input id={id} value={form.notes} placeholder="Konum, seri no…" onChange={(ev) => setForm({ ...form, notes: ev.target.value })} />}</Field>
        <Checkbox label="Aktif (pasif edge'e dağıtım yapılmaz)" checked={form.is_active} onChange={(ev) => setForm({ ...form, is_active: ev.target.checked })} />
      </div>
    </Dialog>
  );
}

function CheckDialog({ edge, onClose }: { edge: Edge | null; onClose: () => void }) {
  const check = useQuery({
    queryKey: ["edge-check", edge?.id],
    enabled: !!edge,
    queryFn: () => api<EdgeCheck>(`/api/edges/${edge!.id}/check`, { method: "POST" }),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const icon = { ok: <CheckCircle2 className="size-4 text-good" />, warn: <AlertTriangle className="size-4 text-warning" />, error: <XCircle className="size-4 text-critical" /> };
  return (
    <Dialog open={!!edge} onClose={onClose} title={edge ? `Kontrol: ${edge.code}` : ""} wide>
      {check.isFetching ? <Spinner label="Node-RED inceleniyor (salt okunur)…" /> : check.error ? <ErrorBox error={check.error} /> : check.data && (
        <div className="space-y-4">
          <ul className="space-y-1.5">
            {check.data.items.map((i) => <li key={i.text} className="flex items-start gap-2">{icon[i.status]}<span>{i.text}</span></li>)}
          </ul>
          {!!check.data.tabs?.length && (
            <div>
              <h3 className="mb-1 text-[13px] font-medium text-ink-2">Node-RED sekmeleri</h3>
              <div className="flex flex-wrap gap-1.5">
                {check.data.tabs.map((t) => <Badge key={t.label} tone={t.managed ? "accent" : "neutral"}>{t.managed ? "MES · " : ""}{t.label}</Badge>)}
              </div>
            </div>
          )}
          {!!check.data.existing_s7_endpoints?.length && (
            <div>
              <h3 className="mb-1 text-[13px] font-medium text-ink-2">Mevcut (MES dışı) S7 bağlantıları</h3>
              <ul className="text-[13px] text-ink-2">
                {check.data.existing_s7_endpoints.map((e, i) => <li key={i} className="font-mono">{e.address}:{e.port} rack/slot {e.rack}/{e.slot} · {e.variables} değişken · {e.cycletime} ms</li>)}
              </ul>
            </div>
          )}
          <p className={`font-medium ${check.data.ok ? "text-success" : "text-danger"}`}>{check.data.ok ? "Uyumlu — dağıtıma hazır." : "Hataları giderin."}</p>
        </div>
      )}
    </Dialog>
  );
}
