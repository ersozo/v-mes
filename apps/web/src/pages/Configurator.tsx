// PLC konfigüratörü (Zero-Code): hiyerarşi ağacı, makine + tag düzenleme (anlık doğrulama), Node-RED önizleme/deploy.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ChevronRight, Cpu, Factory, History, Plus, Rocket, Rows3, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge, Button, Card, Checkbox, Dialog, Empty, ErrorBox, Field, Input, PageHeader, Select, Spinner, Table, cn } from "../components/ui";
import { api } from "../lib/api";
import { dateTime } from "../lib/format";
import type { Deployment, FlowPreview, HierarchyArea, Line, MachineDetail, PlcConfig, Tag, TagRole } from "../lib/types";
import { useUrlState } from "../lib/url-state";

type Sel = { kind: "area" | "line" | "machine"; id: number | null; parent?: number };

const ROLE_LABEL: Record<TagRole, string> = {
  total_count: "Toplam sayaç",
  scrap_count: "Hurda sayacı",
  running: "Çalışıyor bit'i",
  state_code: "Durum kodu",
  process: "Proses değeri",
};

const ROLE_HINT: Record<TagRole, string> = {
  total_count: "DINT / DWORD / WORD",
  scrap_count: "DINT / DWORD / WORD",
  running: "X (bit) veya tamsayı",
  state_code: "1 = çalışıyor",
  process: "her tip",
};

function parseSel(v: string): Sel | null {
  const [kind, id, parent] = v.split(":");
  if (kind !== "area" && kind !== "line" && kind !== "machine") return null;
  return { kind, id: id === "new" ? null : Number(id), ...(parent ? { parent: Number(parent) } : {}) };
}

export function ConfiguratorPage() {
  const hierarchy = useQuery({ queryKey: ["hierarchy"], queryFn: () => api<HierarchyArea[]>("/api/hierarchy") });
  const [selRaw, setSelRaw] = useUrlState("sel", "");
  const sel = parseSel(selRaw);
  const select = (s: Sel) => setSelRaw(`${s.kind}:${s.id ?? "new"}${s.parent ? `:${s.parent}` : ""}`);

  return (
    <div className="mx-auto max-w-[1500px]">
      <PageHeader title="PLC konfigüratörü" subtitle="Makineleri ve okunacak PLC adreslerini tanımlayın, ardından Node-RED'e dağıtın." />
      <DeployPanel />
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[300px_1fr]">
        <Card className="p-2">
          {hierarchy.isLoading ? <Spinner /> : <Tree data={hierarchy.data ?? []} sel={sel} onSelect={select} />}
        </Card>
        <div>
          {!sel ? (
            <Card>
              <Empty title="Soldan bir öğe seçin" icon={<Cpu className="size-8" />}>
                Yeni bir makine eklemek için hattın yanındaki + düğmesini kullanın.
              </Empty>
            </Card>
          ) : sel.kind === "area" ? (
            <AreaForm key={selRaw} id={sel.id} onSaved={(id) => select({ kind: "area", id })} onDeleted={() => setSelRaw("")} data={hierarchy.data ?? []} />
          ) : sel.kind === "line" ? (
            <LineForm key={selRaw} id={sel.id} areaId={sel.parent} data={hierarchy.data ?? []} onSaved={(id) => select({ kind: "line", id })} onDeleted={() => setSelRaw("")} />
          ) : (
            <MachineForm key={selRaw} id={sel.id} lineId={sel.parent} data={hierarchy.data ?? []} onSaved={(id) => select({ kind: "machine", id })} onDeleted={() => setSelRaw("")} />
          )}
        </div>
      </div>
    </div>
  );
}

function Tree({ data, sel, onSelect }: { data: HierarchyArea[]; sel: Sel | null; onSelect: (s: Sel) => void }) {
  const is = (k: Sel["kind"], id: number) => sel?.kind === k && sel.id === id;
  const item = (active: boolean) =>
    cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-surface-2", active && "bg-surface-2 font-medium");
  const addBtn = (label: string, onClick: () => void) => (
    <button onClick={onClick} className="rounded p-1 text-muted opacity-0 group-hover:opacity-100 hover:bg-surface hover:text-ink focus:opacity-100" title={label} aria-label={label}>
      <Plus className="size-3.5" />
    </button>
  );
  return (
    <nav aria-label="Hiyerarşi" className="text-[13px]">
      {data.map((a) => (
        <div key={a.id} className="mb-1">
          <div className="group flex items-center">
            <button className={item(is("area", a.id))} onClick={() => onSelect({ kind: "area", id: a.id })}>
              <Factory className="size-4 text-muted" /> {a.name}
            </button>
            {addBtn("Hat ekle", () => onSelect({ kind: "line", id: null, parent: a.id }))}
          </div>
          {a.lines.map((l) => (
            <div key={l.id} className="ml-4">
              <div className="group flex items-center">
                <button className={item(is("line", l.id))} onClick={() => onSelect({ kind: "line", id: l.id })}>
                  <Rows3 className="size-4 text-muted" /> {l.name}
                </button>
                {addBtn("Makine ekle", () => onSelect({ kind: "machine", id: null, parent: l.id }))}
              </div>
              {l.machines.map((m) => (
                <button key={m.id} className={cn(item(is("machine", m.id)), "ml-4 w-[calc(100%-1rem)]")} onClick={() => onSelect({ kind: "machine", id: m.id })}>
                  <ChevronRight className="size-3.5 text-muted" />
                  <span className={cn(!m.is_active && "text-muted line-through")}>{m.code}</span>
                  {!m.has_plc_config && <AlertTriangle className="ml-auto size-3.5 text-[var(--status-serious)]" aria-label="PLC konfigürasyonu yok" />}
                </button>
              ))}
            </div>
          ))}
        </div>
      ))}
      <Button size="sm" variant="ghost" className="mt-2 w-full" icon={<Plus className="size-4" />} onClick={() => onSelect({ kind: "area", id: null })}>
        Alan ekle
      </Button>
    </nav>
  );
}

function useSave<T>(path: string, id: number | null, onSaved: (id: number) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: T) => api<{ id: number }>(id ? `${path}/${id}` : path, { method: id ? "PATCH" : "POST", json: body }),
    onSuccess: (r) => {
      void qc.invalidateQueries();
      onSaved(r.id);
    },
  });
}

function useDelete(path: string, onDeleted: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api(path, { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries();
      onDeleted();
    },
  });
}

function FormCard({ title, children, onSave, saving, error, onDelete, deleting, deleteError }: {
  title: string; children: React.ReactNode; onSave: () => void; saving: boolean; error: unknown; onDelete?: () => void; deleting?: boolean; deleteError?: unknown;
}) {
  return (
    <Card className="p-5">
      <h2 className="mb-4 text-base font-semibold">{title}</h2>
      <div className="space-y-4">
        {!!(error || deleteError) && <ErrorBox error={error || deleteError} />}
        {children}
        <div className="flex justify-between gap-2 border-t border-line pt-4">
          {onDelete ? (
            <Button variant="danger" icon={<Trash2 className="size-4" />} loading={deleting} onClick={onDelete}>
              Sil
            </Button>
          ) : <span />}
          <Button variant="primary" loading={saving} onClick={onSave}>
            Kaydet
          </Button>
        </div>
      </div>
    </Card>
  );
}

function AreaForm({ id, data, onSaved, onDeleted }: { id: number | null; data: HierarchyArea[]; onSaved: (id: number) => void; onDeleted: () => void }) {
  const area = data.find((a) => a.id === id);
  const [form, setForm] = useState({ slug: area?.slug ?? "", name: area?.name ?? "", sort_order: area?.sort_order ?? 0 });
  const save = useSave("/api/areas", id, onSaved);
  const del = useDelete(`/api/areas/${id}`, onDeleted);
  return (
    <FormCard title={id ? `Alan: ${area?.name}` : "Yeni alan"} onSave={() => save.mutate(form)} saving={save.isPending} error={save.error}
      onDelete={id ? () => del.mutate() : undefined} deleting={del.isPending} deleteError={del.error}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Ad">{(fid) => <Input id={fid} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
        <Field label="Kısa ad (UNS)" hint="küçük harf, rakam, tire — topic yolunda kullanılır">{(fid) => <Input id={fid} value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} />}</Field>
      </div>
    </FormCard>
  );
}

function LineForm({ id, areaId, data, onSaved, onDeleted }: { id: number | null; areaId?: number; data: HierarchyArea[]; onSaved: (id: number) => void; onDeleted: () => void }) {
  const line: Line | undefined = data.flatMap((a) => a.lines).find((l) => l.id === id);
  const [form, setForm] = useState({ area_id: line?.area_id ?? areaId ?? data[0]?.id ?? 0, slug: line?.slug ?? "", name: line?.name ?? "", edge_id: line?.edge_id ?? "edge-01", sort_order: line?.sort_order ?? 0 });
  const save = useSave("/api/lines", id, onSaved);
  const del = useDelete(`/api/lines/${id}`, onDeleted);
  return (
    <FormCard title={id ? `Hat: ${line?.name}` : "Yeni hat"} onSave={() => save.mutate(form)} saving={save.isPending} error={save.error}
      onDelete={id ? () => del.mutate() : undefined} deleting={del.isPending} deleteError={del.error}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Alan">{(fid) => (
          <Select id={fid} value={form.area_id} onChange={(e) => setForm({ ...form, area_id: Number(e.target.value) })}>
            {data.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
        )}</Field>
        <Field label="Ad">{(fid) => <Input id={fid} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
        <Field label="Kısa ad (UNS)" hint="küçük harf, rakam, tire">{(fid) => <Input id={fid} value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} />}</Field>
        <Field label="Edge (Node-RED)" hint="Bu hattı sorgulayan Node-RED örneği">{(fid) => <Input id={fid} value={form.edge_id} onChange={(e) => setForm({ ...form, edge_id: e.target.value })} />}</Field>
      </div>
    </FormCard>
  );
}

const emptyPlc: PlcConfig = { protocol: "s7", host: "", port: 102, rack: 0, slot: 1, poll_ms: 1000, tags: [{ name: "total_count", address: "DB1,DINT0", role: "total_count", unit: "pcs" }] };

interface Validation {
  valid: boolean;
  errors: { loc: (string | number)[]; msg: string }[];
  warnings: string[];
}

function MachineForm({ id, lineId, data, onSaved, onDeleted }: { id: number | null; lineId?: number; data: HierarchyArea[]; onSaved: (id: number) => void; onDeleted: () => void }) {
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ["machine", id], queryFn: () => api<MachineDetail>(`/api/machines/${id}`), enabled: id !== null });
  const lines = data.flatMap((a) => a.lines.map((l) => ({ ...l, areaName: a.name })));
  const [m, setM] = useState({ line_id: lineId ?? lines[0]?.id ?? 0, code: "", name: "", is_active: true, state_source: "tag" as "tag" | "counter", counter_idle_seconds: 120, scrap_source: "manual" as "plc" | "manual" });
  const [plc, setPlc] = useState<PlcConfig>(emptyPlc);
  const [validation, setValidation] = useState<Validation | null>(null);
  const del = useDelete(`/api/machines/${id}`, onDeleted);

  useEffect(() => {
    if (!detail.data) return;
    const d = detail.data;
    setM({ line_id: d.line_id, code: d.code, name: d.name, is_active: d.is_active, state_source: d.state_source, counter_idle_seconds: d.counter_idle_seconds, scrap_source: d.scrap_source });
    setPlc(d.plc ?? emptyPlc);
  }, [detail.data]);

  // Anlık doğrulama (kaydetmeden): 400 ms bekleyip API'ye sor. Yeni makinede id yok → yalnızca kayıtta doğrulanır.
  useEffect(() => {
    if (id === null) return;
    const t = setTimeout(() => {
      api<Validation>(`/api/machines/${id}/plc/validate`, { method: "POST", json: plc }).then(setValidation).catch(() => setValidation(null));
    }, 400);
    return () => clearTimeout(t);
  }, [plc, id, m.state_source, m.scrap_source]);

  const save = useMutation({
    mutationFn: async () => {
      if (id === null) {
        const created = await api<MachineDetail>("/api/machines", { method: "POST", json: { ...m, plc: plc.host ? plc : null } });
        return created.id;
      }
      const { code: _code, ...patch } = m;
      await api(`/api/machines/${id}`, { method: "PATCH", json: patch });
      if (plc.host) await api(`/api/machines/${id}/plc`, { method: "PUT", json: plc });
      return id;
    },
    onSuccess: (newId) => {
      void qc.invalidateQueries();
      onSaved(newId);
    },
  });

  const setTag = (i: number, patch: Partial<Tag>) => setPlc({ ...plc, tags: plc.tags.map((t, j) => (j === i ? { ...t, ...patch } : t)) });
  const tagError = (i: number) => validation?.errors.filter((e) => e.loc[0] === "tags" && e.loc[1] === i).map((e) => e.msg).join(" ");
  const generalErrors = validation?.errors.filter((e) => !(e.loc[0] === "tags" && typeof e.loc[1] === "number")) ?? [];

  if (id !== null && detail.isLoading) return <Spinner />;

  return (
    <FormCard title={id ? `Makine: ${m.name}` : "Yeni makine"} onSave={() => save.mutate()} saving={save.isPending} error={save.error}
      onDelete={id ? () => del.mutate() : undefined} deleting={del.isPending} deleteError={del.error}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label="Makine kodu (UNS)" hint={id ? "Kod sonradan değiştirilemez" : "küçük harf, rakam, tire — ör. cnc-03"}>
          {(fid) => <Input id={fid} value={m.code} disabled={id !== null} onChange={(e) => setM({ ...m, code: e.target.value })} />}
        </Field>
        <Field label="Ad">{(fid) => <Input id={fid} value={m.name} onChange={(e) => setM({ ...m, name: e.target.value })} />}</Field>
        <Field label="Hat">{(fid) => (
          <Select id={fid} value={m.line_id} onChange={(e) => setM({ ...m, line_id: Number(e.target.value) })}>
            {lines.map((l) => <option key={l.id} value={l.id}>{l.areaName} / {l.name}</option>)}
          </Select>
        )}</Field>
        <Field label="Çalışma durumu kaynağı">{(fid) => (
          <Select id={fid} value={m.state_source} onChange={(e) => setM({ ...m, state_source: e.target.value as "tag" | "counter" })}>
            <option value="tag">PLC durum tag'i</option>
            <option value="counter">Sayaç hareketinden</option>
          </Select>
        )}</Field>
        {m.state_source === "counter" && (
          <Field label="Hareketsizlik eşiği (sn)" hint="Sayaç bu süre artmazsa makine duruyor sayılır">
            {(fid) => <Input id={fid} type="number" min={5} max={3600} value={m.counter_idle_seconds} onChange={(e) => setM({ ...m, counter_idle_seconds: Number(e.target.value) })} />}
          </Field>
        )}
        <Field label="Hurda kaynağı">{(fid) => (
          <Select id={fid} value={m.scrap_source} onChange={(e) => setM({ ...m, scrap_source: e.target.value as "plc" | "manual" })}>
            <option value="manual">Operatör girişi</option>
            <option value="plc">PLC hurda sayacı</option>
          </Select>
        )}</Field>
        <div className="flex items-end pb-2">
          <Checkbox label="Aktif" checked={m.is_active} onChange={(e) => setM({ ...m, is_active: e.target.checked })} />
        </div>
      </div>

      <div className="border-t border-line pt-4">
        <h3 className="mb-1 font-semibold">PLC bağlantısı (Siemens S7)</h3>
        <p className="mb-3 text-[12px] text-muted">S7-1200/1500: rack 0, slot 1. Okunan DB'lerde "Optimized block access" kapalı ve CPU'da PUT/GET erişimi açık olmalı.</p>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
          <div className="col-span-2">
            <Field label="IP / host">{(fid) => <Input id={fid} value={plc.host} placeholder="192.168.10.21" onChange={(e) => setPlc({ ...plc, host: e.target.value })} />}</Field>
          </div>
          <Field label="Port">{(fid) => <Input id={fid} type="number" value={plc.port} onChange={(e) => setPlc({ ...plc, port: Number(e.target.value) })} />}</Field>
          <Field label="Rack / slot">{(fid) => (
            <div className="flex gap-1">
              <Input id={fid} type="number" min={0} max={7} value={plc.rack} onChange={(e) => setPlc({ ...plc, rack: Number(e.target.value) })} aria-label="Rack" />
              <Input type="number" min={0} max={31} value={plc.slot} onChange={(e) => setPlc({ ...plc, slot: Number(e.target.value) })} aria-label="Slot" />
            </div>
          )}</Field>
          <Field label="Okuma periyodu (ms)">{(fid) => <Input id={fid} type="number" min={100} max={60000} step={100} value={plc.poll_ms} onChange={(e) => setPlc({ ...plc, poll_ms: Number(e.target.value) })} />}</Field>
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="font-semibold">Tag'ler</h3>
          {validation && (
            validation.valid
              ? <Badge tone="good"><CheckCircle2 className="size-3.5" /> Geçerli</Badge>
              : <Badge tone="critical"><AlertTriangle className="size-3.5" /> Düzeltilmesi gereken alanlar var</Badge>
          )}
        </div>
        <Table>
          <thead>
            <tr>
              <th>Ad</th>
              <th>Adres</th>
              <th>Rol</th>
              <th>Birim</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {plc.tags.map((t, i) => {
              const err = tagError(i);
              return (
                <tr key={i} className="align-top">
                  <td><Input value={t.name} onChange={(e) => setTag(i, { name: e.target.value })} aria-label="Tag adı" className="h-8" /></td>
                  <td>
                    <Input value={t.address} onChange={(e) => setTag(i, { address: e.target.value })} aria-label="Adres" placeholder="DB1,DINT0" className={cn("h-8 font-mono", err && "border-critical")} aria-invalid={!!err} />
                    {err && <p className="mt-1 max-w-xs text-[12px] text-danger">{err}</p>}
                  </td>
                  <td>
                    <Select value={t.role} onChange={(e) => setTag(i, { role: e.target.value as TagRole })} aria-label="Rol" className="h-8">
                      {(Object.keys(ROLE_LABEL) as TagRole[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                    </Select>
                    <p className="mt-1 text-[11px] text-muted">{ROLE_HINT[t.role]}</p>
                  </td>
                  <td><Input value={t.unit ?? ""} onChange={(e) => setTag(i, { unit: e.target.value || null })} aria-label="Birim" className="h-8 w-20" /></td>
                  <td>
                    <button className="rounded p-1.5 text-muted hover:bg-surface-2 hover:text-danger" onClick={() => setPlc({ ...plc, tags: plc.tags.filter((_, j) => j !== i) })} aria-label="Tag'i sil">
                      <Trash2 className="size-4" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
        <Button size="sm" variant="ghost" className="mt-2" icon={<Plus className="size-4" />} onClick={() => setPlc({ ...plc, tags: [...plc.tags, { name: "", address: "", role: "process", unit: null }] })}>
          Tag ekle
        </Button>
        {(generalErrors.length > 0 || (validation?.warnings.length ?? 0) > 0) && (
          <ul className="mt-3 space-y-1 text-[13px]">
            {generalErrors.map((e, i) => <li key={i} className="flex gap-2 text-danger"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{e.msg}</li>)}
            {validation?.warnings.map((w) => <li key={w} className="flex gap-2 text-ink-2"><AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--status-warning)]" />{w}</li>)}
          </ul>
        )}
      </div>
    </FormCard>
  );
}

function DeployPanel() {
  const qc = useQueryClient();
  const [historyOpen, setHistoryOpen] = useState(false);
  const preview = useQuery({ queryKey: ["flows-preview"], queryFn: () => api<FlowPreview>("/api/flows/preview"), refetchOnWindowFocus: true });
  const history = useQuery({ queryKey: ["deployments"], queryFn: () => api<Deployment[]>("/api/flows/deployments?limit=30"), enabled: historyOpen });
  const deploy = useMutation({
    mutationFn: () => api<{ status: string }>("/api/flows/deploy", { method: "POST" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["flows-preview"] });
      void qc.invalidateQueries({ queryKey: ["deployments"] });
    },
  });
  const d = preview.data?.diff;
  const label = (tab: string) => tab.replace("mes-line-", "hat #").replace("mes-edge-", "edge ");

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Rocket className="size-5 text-accent" aria-hidden />
          <div>
            <div className="font-semibold">Node-RED dağıtımı {preview.data && <span className="font-normal text-muted">· {preview.data.edge_id}</span>}</div>
            <div className="text-[13px] text-ink-2">
              {preview.isLoading ? "Kontrol ediliyor…" : preview.error ? "Node-RED'e ulaşılamadı" : d?.has_changes
                ? [d.added.length && `${d.added.length} yeni`, d.changed.length && `${d.changed.length} değişen`, d.removed.length && `${d.removed.length} kaldırılacak`].filter(Boolean).join(" · ") + " sekme — yalnızca bunlar yeniden başlatılır"
                : "Node-RED güncel"}
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" icon={<History className="size-4" />} onClick={() => setHistoryOpen(true)}>Geçmiş</Button>
          <Button variant="primary" icon={<Rocket className="size-4" />} disabled={!d?.has_changes} loading={deploy.isPending} onClick={() => deploy.mutate()}>Dağıt</Button>
        </div>
      </div>
      {d?.has_changes && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {d.added.map((t) => <Badge key={t} tone="good">+ {label(t)}</Badge>)}
          {d.changed.map((t) => <Badge key={t} tone="warning">~ {label(t)}</Badge>)}
          {d.removed.map((t) => <Badge key={t} tone="critical">− {label(t)}</Badge>)}
        </div>
      )}
      {preview.data?.warnings.map((w) => (
        <p key={w} className="mt-2 flex gap-2 text-[13px] text-ink-2"><AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--status-warning)]" />{w}</p>
      ))}
      {(deploy.error || preview.error) && <div className="mt-3"><ErrorBox error={deploy.error || preview.error} /></div>}
      {deploy.data && <p className="mt-2 text-[13px] text-success" role="status">{deploy.data.status === "deployed" ? "Dağıtım tamamlandı." : "Değişiklik yoktu."}</p>}

      <Dialog open={historyOpen} onClose={() => setHistoryOpen(false)} title="Dağıtım geçmişi" wide>
        <Table>
          <thead><tr><th>Zaman</th><th>Kullanıcı</th><th>Sonuç</th><th>Değişiklik</th></tr></thead>
          <tbody>
            {(history.data ?? []).map((h) => (
              <tr key={h.id}>
                <td className="tabular">{dateTime(h.deployed_at)}</td>
                <td>{h.deployed_by ?? "—"}</td>
                <td><Badge tone={h.status === "success" ? "good" : "critical"}>{h.status === "success" ? "Başarılı" : "Başarısız"}</Badge></td>
                <td className="text-ink-2">{h.error ?? [...(h.summary?.diff?.added ?? []), ...(h.summary?.diff?.changed ?? []), ...(h.summary?.diff?.removed ?? [])].map(label).join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Dialog>
    </Card>
  );
}
