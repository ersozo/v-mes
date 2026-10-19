// TIA Portal DB tablosundan tag içe aktarma sihirbazı: dosya/yapıştır → satır seç, ad ve rol ata → tag listesine ekle.
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, FileSpreadsheet, Lightbulb } from "lucide-react";
import { useMemo, useState } from "react";
import { api } from "../lib/api";
import type { Tag, TagRole } from "../lib/types";
import { Badge, Button, Checkbox, Dialog, ErrorBox, Field, Input, Segmented, Select, Table, cn } from "./ui";

interface ImportRow {
  line: number;
  path: string;
  name: string;
  tia_type: string | null;
  offset: string;
  address: string | null;
  supported: boolean;
  note: string | null;
  suggested_role: "process" | "total_count_candidate" | "scrap_count_candidate" | "running_candidate";
}

interface ImportResult {
  db_number: number | null;
  rows: ImportRow[];
  warnings: string[];
}

const ROLE_OPTIONS: { value: TagRole; label: string }[] = [
  { value: "process", label: "Proses değeri" },
  { value: "total_count", label: "Toplam sayaç" },
  { value: "scrap_count", label: "Hurda sayacı" },
  { value: "running", label: "Çalışıyor bit'i" },
  { value: "state_code", label: "Durum kodu" },
];
const SINGLE: TagRole[] = ["total_count", "scrap_count", "running", "state_code"];
const HINT: Record<ImportRow["suggested_role"], string | null> = {
  process: null,
  total_count_candidate: "sayaç adayı",
  scrap_count_candidate: "hurda adayı",
  running_candidate: "çalışıyor adayı",
};

interface Draft {
  selected: boolean;
  name: string;
  role: TagRole;
  unit: string;
}

export function ImportTagsDialog({ open, onClose, onImport, existing }: { open: boolean; onClose: () => void; onImport: (tags: Tag[], mode: "append" | "replace") => void; existing: Tag[] }) {
  const [source, setSource] = useState<"file" | "paste">("file");
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [db, setDb] = useState("");
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [mode, setMode] = useState<"append" | "replace">("append");

  const parse = useMutation({
    mutationFn: () => {
      const fd = new FormData();
      if (source === "file" && file) fd.append("file", file);
      if (source === "paste") fd.append("text", text);
      if (db) fd.append("db_number", db);
      return api<ImportResult>("/api/plc/import", { method: "POST", body: fd });
    },
    onSuccess: (r) => {
      setDrafts(Object.fromEntries(r.rows.map((row) => [row.line, { selected: false, name: row.name, role: "process" as TagRole, unit: "" }])));
      if (r.db_number && !db) setDb(String(r.db_number));
    },
  });

  const rows = parse.data?.rows ?? [];
  const setDraft = (line: number, patch: Partial<Draft>) =>
    setDrafts((d) => {
      const next = { ...d, [line]: { ...d[line]!, ...patch } };
      // Tekil roller (toplam sayaç, çalışıyor…) yalnızca bir satırda olabilir
      if (patch.role && SINGLE.includes(patch.role)) {
        for (const k of Object.keys(next)) if (Number(k) !== line && next[Number(k)]!.role === patch.role) next[Number(k)] = { ...next[Number(k)]!, role: "process" };
        next[line] = { ...next[line]!, selected: true };
      }
      return next;
    });

  const chosen = useMemo(() => rows.filter((r) => r.supported && drafts[r.line]?.selected), [rows, drafts]);
  const nameClash = useMemo(() => {
    const names = chosen.map((r) => drafts[r.line]!.name);
    const pool = mode === "append" ? [...names, ...existing.map((t) => t.name)] : names;
    return new Set(pool.filter((n, i) => pool.indexOf(n) !== i));
  }, [chosen, drafts, existing, mode]);

  const commit = () => {
    onImport(chosen.map((r) => ({ name: drafts[r.line]!.name, address: r.address!, role: drafts[r.line]!.role, unit: drafts[r.line]!.unit || null })), mode);
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} title="TIA Portal'dan tag içe aktar" size="xl"
      footer={
        <>
          {parse.data && <Segmented size="sm" label="İçe aktarma biçimi" value={mode} onChange={setMode} options={[{ value: "append", label: "Mevcut listeye ekle" }, { value: "replace", label: "Listenin yerine geç" }]} />}
          <span className="flex-1" />
          <Button variant="ghost" onClick={onClose}>Vazgeç</Button>
          <Button variant="primary" disabled={!chosen.length || nameClash.size > 0} onClick={commit}>{chosen.length} tag'i aktar</Button>
        </>
      }>
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <Segmented label="Kaynak" value={source} onChange={setSource} options={[{ value: "file", label: "Excel / CSV dosyası" }, { value: "paste", label: "DB editöründen yapıştır" }]} />
          <div className="w-28">
            <Field label="DB numarası" hint="boşsa dosyadan">{(id) => <Input id={id} inputMode="numeric" value={db} onChange={(e) => setDb(e.target.value.replace(/\D/g, ""))} placeholder="200" />}</Field>
          </div>
        </div>
        {source === "file" ? (
          <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-line p-4 hover:bg-surface-2">
            <FileSpreadsheet className="size-6 text-muted" aria-hidden />
            <span className="flex-1 text-ink-2">{file ? file.name : "TIA'dan dışa aktarılmış DB tablosunu seçin (.xlsx veya .csv; ad, veri tipi ve ofset sütunları)"}</span>
            <input type="file" accept=".xlsx,.xlsm,.csv,.txt" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
        ) : (
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} placeholder="TIA Portal'da DB'yi açın → satırları seçip Ctrl+C → buraya yapıştırın"
            className="w-full rounded-lg border border-line bg-surface p-3 font-mono text-[12px] text-ink focus:border-accent focus:outline-none" />
        )}
        <div className="flex items-center gap-3">
          <Button loading={parse.isPending} disabled={source === "file" ? !file : !text.trim()} onClick={() => parse.mutate()}>Satırları oku</Button>
          <p className="flex items-center gap-1.5 text-[12px] text-muted"><Lightbulb className="size-3.5" />DB'de "Optimized block access" kapalı olmalı; ofset sütunu görünmüyorsa optimize edilmiştir.</p>
        </div>
        {parse.error && <ErrorBox error={parse.error} />}
        {parse.data?.warnings.map((w) => <p key={w} className="flex gap-2 text-[13px] text-ink-2"><AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--status-warning)]" />{w}</p>)}

        {rows.length > 0 && (
          <>
            <div className="flex items-center justify-between text-[13px]">
              <span className="text-ink-2">{rows.filter((r) => r.supported).length} okunabilir satır · {chosen.length} seçili</span>
              <Checkbox label="Okunabilirlerin hepsini seç" checked={rows.filter((r) => r.supported).every((r) => drafts[r.line]?.selected)}
                onChange={(e) => setDrafts((d) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, { ...v, selected: e.target.checked && !!rows.find((r) => r.line === Number(k))?.supported }])))} />
            </div>
            <div className="max-h-[50vh] overflow-auto rounded-lg border border-line">
              <Table>
                <thead className="sticky top-0 bg-surface">
                  <tr><th /><th>TIA yolu</th><th>Tip</th><th>Adres</th><th>Tag adı</th><th>Rol</th><th>Birim</th></tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const d = drafts[r.line];
                    if (!d) return null;
                    return (
                      <tr key={r.line} className={cn("align-top", !r.supported && "opacity-50")}>
                        <td><input type="checkbox" className="mt-2 size-4 accent-[var(--accent)]" disabled={!r.supported} checked={d.selected} onChange={(e) => setDraft(r.line, { selected: e.target.checked })} aria-label={`${r.path} seç`} /></td>
                        <td className="pt-2.5">
                          <div className="font-mono text-[12px]">{r.path}</div>
                          {r.note && <div className="mt-0.5 text-[11px] text-[var(--status-serious)]">{r.note}</div>}
                          {HINT[r.suggested_role] && <Badge tone="accent">{HINT[r.suggested_role]}</Badge>}
                        </td>
                        <td className="pt-2.5 text-ink-2">{r.tia_type ?? "?"}</td>
                        <td className="pt-2.5 font-mono text-[12px]">{r.address ?? "—"}</td>
                        <td><Input className={cn("h-8 w-80 font-mono text-[12px]", nameClash.has(d.name) && d.selected && "border-critical")} value={d.name} disabled={!r.supported} onChange={(e) => setDraft(r.line, { name: e.target.value })} aria-label="Tag adı" /></td>
                        <td>
                          <Select className="h-8 w-40" value={d.role} disabled={!r.supported} onChange={(e) => setDraft(r.line, { role: e.target.value as TagRole })} aria-label="Rol">
                            {ROLE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </Select>
                        </td>
                        <td><Input className="h-8 w-16" value={d.unit} disabled={!r.supported} onChange={(e) => setDraft(r.line, { unit: e.target.value })} aria-label="Birim" /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            </div>
            {nameClash.size > 0 && <p className="text-[13px] text-danger">Aynı tag adı birden fazla kez kullanılıyor: {[...nameClash].join(", ")}</p>}
            <p className="text-[12px] text-muted">Toplam sayaç, hurda sayacı, çalışıyor bit'i ve durum kodu rolleri yalnızca bir tag'e atanabilir. Aktarılan tag'ler kaydetmeden önce doğrulanır.</p>
          </>
        )}
      </div>
    </Dialog>
  );
}
