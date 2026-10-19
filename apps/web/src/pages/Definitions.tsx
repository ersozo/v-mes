import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { CategoryTag } from "../components/state";
import { Badge, Button, Card, Checkbox, Dialog, ErrorBox, Field, Input, PageHeader, Segmented, Select, Spinner, Table } from "../components/ui";
import { api } from "../lib/api";
import { can, useAuth } from "../lib/auth";
import type { DowntimeReason, HierarchyArea, PlantSettings, Product, Rate, Shift } from "../lib/types";
import { useUrlState } from "../lib/url-state";

type Tab = "products" | "shifts" | "reasons" | "settings";

export function DefinitionsPage() {
  const [tab, setTab] = useUrlState<Tab>("tab", "products");
  return (
    <div className="mx-auto max-w-[1200px]">
      <PageHeader
        title="Tanımlar"
        actions={
          <Segmented label="Bölüm" value={tab} onChange={setTab} options={[
            { value: "products", label: "Ürünler" },
            { value: "shifts", label: "Vardiyalar" },
            { value: "reasons", label: "Duruş nedenleri" },
            { value: "settings", label: "Fabrika ayarları" },
          ]} />
        }
      />
      {tab === "products" ? <Products /> : tab === "shifts" ? <Shifts /> : tab === "reasons" ? <Reasons /> : <Settings />}
    </div>
  );
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries();
}

// --- Ürünler ve çevrim süreleri ---------------------------------------------------

function Products() {
  const products = useQuery({ queryKey: ["products"], queryFn: () => api<Product[]>("/api/products") });
  const [edit, setEdit] = useState<Product | "new" | null>(null);
  return (
    <Card>
      <div className="flex items-center justify-between p-4">
        <p className="text-ink-2">Performans hesabı, ürünün her makinedeki ideal çevrim süresini kullanır.</p>
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEdit("new")}>Ürün ekle</Button>
      </div>
      {products.isLoading ? <Spinner /> : (
        <Table>
          <thead><tr><th>Kod</th><th>Ad</th><th>Durum</th><th /></tr></thead>
          <tbody>
            {(products.data ?? []).map((p) => (
              <tr key={p.id}>
                <td className="font-mono">{p.code}</td>
                <td className="font-medium">{p.name}</td>
                <td>{p.is_active ? <Badge tone="good">Aktif</Badge> : <Badge>Pasif</Badge>}</td>
                <td className="text-right"><Button size="sm" onClick={() => setEdit(p)}>Düzenle</Button></td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <ProductDialog product={edit} onClose={() => setEdit(null)} />
    </Card>
  );
}

function ProductDialog({ product, onClose }: { product: Product | "new" | null; onClose: () => void }) {
  const isNew = product === "new";
  const p = product && product !== "new" ? product : null;
  const invalidate = useInvalidate();
  const hierarchy = useQuery({ queryKey: ["hierarchy"], queryFn: () => api<HierarchyArea[]>("/api/hierarchy"), enabled: !!product });
  const rates = useQuery({ queryKey: ["rates", p?.id], queryFn: () => api<Rate[]>(`/api/products/${p!.id}/rates`), enabled: !!p });
  const machines = (hierarchy.data ?? []).flatMap((a) => a.lines.flatMap((l) => l.machines));
  const [form, setForm] = useState({ code: "", name: "", is_active: true });
  const [cycles, setCycles] = useState<Record<number, string>>({});

  useEffect(() => {
    setForm({ code: p?.code ?? "", name: p?.name ?? "", is_active: p?.is_active ?? true });
  }, [product]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setCycles(Object.fromEntries((rates.data ?? []).map((r) => [r.machine_id, String(r.ideal_cycle_seconds)])));
  }, [rates.data]);

  const save = useMutation({
    mutationFn: async () => {
      const saved = isNew
        ? await api<Product>("/api/products", { method: "POST", json: form })
        : await api<Product>(`/api/products/${p!.id}`, { method: "PATCH", json: { name: form.name, is_active: form.is_active } });
      const body = Object.entries(cycles).filter(([, v]) => v && Number(v) > 0).map(([m, v]) => ({ machine_id: Number(m), ideal_cycle_seconds: Number(v.replace(",", ".")) }));
      await api(`/api/products/${saved.id}/rates`, { method: "PUT", json: body });
    },
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });

  return (
    <Dialog open={!!product} onClose={onClose} title={isNew ? "Yeni ürün" : `Ürün: ${p?.name ?? ""}`} wide
      footer={<><Button variant="ghost" onClick={onClose}>Vazgeç</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Kaydet</Button></>}>
      <div className="space-y-4">
        {save.error && <ErrorBox error={save.error} />}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Kod" hint={isNew ? "küçük harf, rakam, . _ -" : "Kod değiştirilemez"}>{(id) => <Input id={id} value={form.code} disabled={!isNew} onChange={(e) => setForm({ ...form, code: e.target.value })} />}</Field>
          <Field label="Ad">{(id) => <Input id={id} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
          <div className="flex items-end pb-2"><Checkbox label="Aktif" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} /></div>
        </div>
        <div>
          <h3 className="mb-1 font-semibold">İdeal çevrim süreleri</h3>
          <p className="mb-2 text-[12px] text-muted">Bir parçanın ideal koşulda üretim süresi (saniye). Boş bırakılan makinede bu ürün için performans hesaplanmaz.</p>
          <Table>
            <thead><tr><th>Makine</th><th className="w-40">Çevrim (sn)</th><th className="text-right">İdeal hız</th></tr></thead>
            <tbody className="tabular">
              {machines.map((m) => {
                const v = Number((cycles[m.id] ?? "").replace(",", "."));
                return (
                  <tr key={m.id}>
                    <td>{m.name} <span className="text-muted">({m.code})</span></td>
                    <td><Input inputMode="decimal" className="h-8" value={cycles[m.id] ?? ""} onChange={(e) => setCycles({ ...cycles, [m.id]: e.target.value })} aria-label={`${m.code} çevrim süresi`} /></td>
                    <td className="text-right text-ink-2">{v > 0 ? `${(3600 / v).toLocaleString("tr-TR", { maximumFractionDigits: 0 })} adet/sa` : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </div>
      </div>
    </Dialog>
  );
}

// --- Vardiyalar ------------------------------------------------------------------

const DAYS = ["Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz"];

function Shifts() {
  const shifts = useQuery({ queryKey: ["shifts"], queryFn: () => api<Shift[]>("/api/shifts") });
  const [edit, setEdit] = useState<Shift | "new" | null>(null);
  return (
    <Card>
      <div className="flex items-center justify-between p-4">
        <p className="text-ink-2">Saatler fabrika yerel saatidir. Bitiş başlangıçtan önceyse vardiya gece yarısını aşar.</p>
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEdit("new")}>Vardiya ekle</Button>
      </div>
      {shifts.isLoading ? <Spinner /> : (
        <Table>
          <thead><tr><th>Ad</th><th>Saat</th><th>Günler</th><th>Planlı duruşlar</th><th>Durum</th><th /></tr></thead>
          <tbody className="tabular">
            {(shifts.data ?? []).map((s) => (
              <tr key={s.id}>
                <td className="font-medium">{s.name}</td>
                <td>{s.start_local.slice(0, 5)}–{s.end_local.slice(0, 5)}</td>
                <td className="text-ink-2">{DAYS.filter((_, i) => s.days_mask & (1 << i)).join(", ")}</td>
                <td className="text-ink-2">{s.planned_stops.map((p) => `${p.name} ${p.start_local.slice(0, 5)} (${p.duration_minutes} dk)`).join(", ") || "—"}</td>
                <td>{s.is_active ? <Badge tone="good">Aktif</Badge> : <Badge>Pasif</Badge>}</td>
                <td className="text-right"><Button size="sm" onClick={() => setEdit(s)}>Düzenle</Button></td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <ShiftDialog shift={edit} onClose={() => setEdit(null)} />
    </Card>
  );
}

function ShiftDialog({ shift, onClose }: { shift: Shift | "new" | null; onClose: () => void }) {
  const invalidate = useInvalidate();
  const s = shift && shift !== "new" ? shift : null;
  const blank = { name: "", start_local: "08:00", end_local: "16:00", days_mask: 63, is_active: true, planned_stops: [] as Shift["planned_stops"] };
  const [form, setForm] = useState(blank);
  useEffect(() => {
    setForm(s ? { name: s.name, start_local: s.start_local.slice(0, 5), end_local: s.end_local.slice(0, 5), days_mask: s.days_mask, is_active: s.is_active, planned_stops: s.planned_stops.map((p) => ({ ...p, start_local: p.start_local.slice(0, 5) })) } : blank);
  }, [shift]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useMutation({
    mutationFn: () => api(s ? `/api/shifts/${s.id}` : "/api/shifts", { method: s ? "PUT" : "POST", json: { ...form, planned_stops: form.planned_stops.map(({ name, start_local, duration_minutes }) => ({ name, start_local, duration_minutes })) } }),
    onSuccess: () => { invalidate(); onClose(); },
  });
  const del = useMutation({ mutationFn: () => api(`/api/shifts/${s!.id}`, { method: "DELETE" }), onSuccess: () => { invalidate(); onClose(); } });
  return (
    <Dialog open={!!shift} onClose={onClose} title={s ? `Vardiya: ${s.name}` : "Yeni vardiya"}
      footer={<>{s && <Button variant="danger" className="mr-auto" loading={del.isPending} onClick={() => del.mutate()}>Sil</Button>}<Button variant="ghost" onClick={onClose}>Vazgeç</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Kaydet</Button></>}>
      <div className="space-y-4">
        {(save.error || del.error) && <ErrorBox error={save.error || del.error} />}
        <Field label="Ad">{(id) => <Input id={id} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Başlangıç">{(id) => <Input id={id} type="time" value={form.start_local} onChange={(e) => setForm({ ...form, start_local: e.target.value })} />}</Field>
          <Field label="Bitiş">{(id) => <Input id={id} type="time" value={form.end_local} onChange={(e) => setForm({ ...form, end_local: e.target.value })} />}</Field>
        </div>
        <fieldset>
          <legend className="mb-1 text-[13px] font-medium text-ink-2">Günler (vardiyanın başladığı gün)</legend>
          <div className="flex flex-wrap gap-1.5">
            {DAYS.map((d, i) => {
              const on = !!(form.days_mask & (1 << i));
              return (
                <button key={d} aria-pressed={on} onClick={() => setForm({ ...form, days_mask: form.days_mask ^ (1 << i) })}
                  className={`h-9 w-12 rounded-lg border text-[13px] font-medium ${on ? "border-accent bg-accent text-accent-ink" : "border-line text-ink-2 hover:bg-surface-2"}`}>{d}</button>
              );
            })}
          </div>
        </fieldset>
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[13px] font-medium text-ink-2">Planlı duruşlar (mola, yemek)</span>
            <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={() => setForm({ ...form, planned_stops: [...form.planned_stops, { name: "Mola", start_local: "10:00", duration_minutes: 15 }] })}>Ekle</Button>
          </div>
          {form.planned_stops.map((p, i) => (
            <div key={i} className="mb-2 flex items-center gap-2">
              <Input value={p.name} onChange={(e) => setForm({ ...form, planned_stops: form.planned_stops.map((x, j) => j === i ? { ...x, name: e.target.value } : x) })} aria-label="Ad" />
              <Input type="time" className="w-32" value={p.start_local} onChange={(e) => setForm({ ...form, planned_stops: form.planned_stops.map((x, j) => j === i ? { ...x, start_local: e.target.value } : x) })} aria-label="Başlangıç" />
              <Input type="number" className="w-24" min={1} value={p.duration_minutes} onChange={(e) => setForm({ ...form, planned_stops: form.planned_stops.map((x, j) => j === i ? { ...x, duration_minutes: Number(e.target.value) } : x) })} aria-label="Süre (dk)" />
              <span className="text-[12px] text-muted">dk</span>
              <button className="rounded p-1.5 text-muted hover:text-danger" onClick={() => setForm({ ...form, planned_stops: form.planned_stops.filter((_, j) => j !== i) })} aria-label="Kaldır"><Trash2 className="size-4" /></button>
            </div>
          ))}
        </div>
        <Checkbox label="Aktif" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
      </div>
    </Dialog>
  );
}

// --- Duruş nedenleri --------------------------------------------------------------

function Reasons() {
  const reasons = useQuery({ queryKey: ["reasons"], queryFn: () => api<DowntimeReason[]>("/api/downtime-reasons") });
  const [edit, setEdit] = useState<DowntimeReason | "new" | null>(null);
  return (
    <Card>
      <div className="flex items-center justify-between p-4">
        <p className="text-ink-2">"Planlı" kategorisindeki nedenler planlı süreden düşülür; diğerleri kullanılabilirlik kaybıdır.</p>
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEdit("new")}>Neden ekle</Button>
      </div>
      {reasons.isLoading ? <Spinner /> : (
        <Table>
          <thead><tr><th>Kod</th><th>Ad</th><th>Kategori</th><th>Durum</th><th /></tr></thead>
          <tbody>
            {(reasons.data ?? []).map((r) => (
              <tr key={r.id}>
                <td className="font-mono">{r.code}</td>
                <td className="font-medium">{r.name}</td>
                <td><CategoryTag category={r.category} /></td>
                <td>{r.is_active ? <Badge tone="good">Aktif</Badge> : <Badge>Pasif</Badge>}</td>
                <td className="text-right"><Button size="sm" onClick={() => setEdit(r)}>Düzenle</Button></td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <ReasonDialog reason={edit} onClose={() => setEdit(null)} />
    </Card>
  );
}

function ReasonDialog({ reason, onClose }: { reason: DowntimeReason | "new" | null; onClose: () => void }) {
  const invalidate = useInvalidate();
  const r = reason && reason !== "new" ? reason : null;
  const [form, setForm] = useState({ code: "", name: "", category: "unplanned" as DowntimeReason["category"], is_active: true });
  useEffect(() => {
    setForm({ code: r?.code ?? "", name: r?.name ?? "", category: r?.category ?? "unplanned", is_active: r?.is_active ?? true });
  }, [reason]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useMutation({
    mutationFn: () => r ? api(`/api/downtime-reasons/${r.id}`, { method: "PATCH", json: { name: form.name, category: form.category, is_active: form.is_active } }) : api("/api/downtime-reasons", { method: "POST", json: form }),
    onSuccess: () => { invalidate(); onClose(); },
  });
  return (
    <Dialog open={!!reason} onClose={onClose} title={r ? `Neden: ${r.name}` : "Yeni duruş nedeni"}
      footer={<><Button variant="ghost" onClick={onClose}>Vazgeç</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Kaydet</Button></>}>
      <div className="space-y-4">
        {save.error && <ErrorBox error={save.error} />}
        <div className="grid grid-cols-2 gap-4">
          <Field label="Kod">{(id) => <Input id={id} value={form.code} disabled={!!r} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} />}</Field>
          <Field label="Kategori">{(id) => (
            <Select id={id} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as DowntimeReason["category"] })}>
              <option value="unplanned">Plansız</option>
              <option value="changeover">Ürün/takım değişimi</option>
              <option value="planned">Planlı</option>
            </Select>
          )}</Field>
        </div>
        <Field label="Ad">{(id) => <Input id={id} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
        <Checkbox label="Aktif (pasif nedenler operatöre gösterilmez; geçmiş kayıtlar korunur)" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
      </div>
    </Dialog>
  );
}

// --- Fabrika ayarları ---------------------------------------------------------------

function Settings() {
  const { user } = useAuth();
  const invalidate = useInvalidate();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api<PlantSettings>("/api/settings") });
  const [form, setForm] = useState<PlantSettings | null>(null);
  useEffect(() => { if (settings.data) setForm(settings.data); }, [settings.data]);
  const save = useMutation({ mutationFn: () => api("/api/settings", { method: "PATCH", json: form }), onSuccess: invalidate });
  const admin = can(user, "admin");
  if (!form) return <Spinner />;
  return (
    <Card className="max-w-2xl p-5">
      {!admin && <p className="mb-4 text-ink-2">Ayarları yalnızca yönetici değiştirebilir.</p>}
      {save.error && <div className="mb-3"><ErrorBox error={save.error} /></div>}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Saat dilimi" hint="IANA adı, ör. Europe/Istanbul">{(id) => <Input id={id} disabled={!admin} value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} />}</Field>
        <Field label="Mikro duruş eşiği (sn)" hint="Daha kısa duruşlar kayıt açmaz; performans kaybına yansır">{(id) => <Input id={id} type="number" disabled={!admin} value={form.min_downtime_seconds} onChange={(e) => setForm({ ...form, min_downtime_seconds: Number(e.target.value) })} />}</Field>
        <Field label="Ham telemetri saklama (gün)">{(id) => <Input id={id} type="number" disabled={!admin} value={form.raw_retention_days} onChange={(e) => setForm({ ...form, raw_retention_days: Number(e.target.value) })} />}</Field>
        <Field label="Edge zaman aşımı (sn)" hint="Bu süre heartbeat gelmezse uyarı verilir">{(id) => <Input id={id} type="number" disabled={!admin} value={form.edge_heartbeat_timeout_seconds} onChange={(e) => setForm({ ...form, edge_heartbeat_timeout_seconds: Number(e.target.value) })} />}</Field>
      </div>
      {admin && <div className="mt-5 flex justify-end"><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Kaydet</Button></div>}
      {save.isSuccess && <p className="mt-2 text-success" role="status">Kaydedildi.</p>}
    </Card>
  );
}
