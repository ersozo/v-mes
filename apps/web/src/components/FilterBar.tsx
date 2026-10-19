// Rapor filtre çubuğu: tüm kartları tek yerden kapsar (kart içinde filtre yok). Değerler URL'de.
import { useQuery } from "@tanstack/react-query";
import { CalendarRange } from "lucide-react";
import { useMemo } from "react";
import { api } from "../lib/api";
import { isoToLocalInput, localInputToIso } from "../lib/format";
import type { HierarchyArea } from "../lib/types";
import { useUrlState } from "../lib/url-state";
import { Checkbox, Input, Segmented, Select } from "./ui";

export const PRESETS = [
  { value: "current_shift", label: "Bu vardiya" },
  { value: "today", label: "Bugün" },
  { value: "yesterday", label: "Dün" },
  { value: "last_7_days", label: "Son 7 gün" },
  { value: "this_month", label: "Bu ay" },
  { value: "custom", label: "Özel" },
] as const;

export type GroupBy = "hour" | "shift" | "day" | "week";

export interface ReportFilters {
  scope: "plant" | "area" | "line" | "machine";
  id: number | null;
  preset: string;
  from: string | null;
  to: string | null;
  groupBy: GroupBy;
  compare: boolean;
  /** API sorgu dizesi (scope, id, preset veya from/to) */
  query: string;
  scopeLabel: string;
  hierarchy: HierarchyArea[];
}

export function defaultGroupBy(preset: string): GroupBy {
  return preset === "last_7_days" ? "day" : preset === "this_month" ? "day" : "hour";
}

export function useReportFilters(): ReportFilters & {
  setScope: (v: string) => void;
  setPreset: (v: string) => void;
  setRange: (from: string, to: string) => void;
  setGroupBy: (v: GroupBy) => void;
  setCompare: (v: boolean) => void;
} {
  const [scopeKey, setScope] = useUrlState("scope", "plant");
  const [preset, setPresetRaw] = useUrlState("preset", "today");
  const [from, setFrom] = useUrlState("from", "");
  const [to, setTo] = useUrlState("to", "");
  const [groupByRaw, setGroupByRaw] = useUrlState<string>("group", "");
  const [compare, setCompareRaw] = useUrlState("compare", "0");
  const hierarchy = useQuery({ queryKey: ["hierarchy"], queryFn: () => api<HierarchyArea[]>("/api/hierarchy") });

  const [scope, idRaw] = scopeKey.split(":") as [ReportFilters["scope"], string | undefined];
  const id = idRaw ? Number(idRaw) : null;
  const groupBy = (groupByRaw || defaultGroupBy(preset)) as GroupBy;

  const scopeLabel = useMemo(() => {
    const h = hierarchy.data ?? [];
    if (scope === "area") return h.find((a) => a.id === id)?.name ?? "Alan";
    if (scope === "line") return h.flatMap((a) => a.lines).find((l) => l.id === id)?.name ?? "Hat";
    if (scope === "machine") return h.flatMap((a) => a.lines.flatMap((l) => l.machines)).find((m) => m.id === id)?.name ?? "Makine";
    return "Tüm fabrika";
  }, [hierarchy.data, scope, id]);

  const params = new URLSearchParams({ scope });
  if (id !== null) params.set("id", String(id));
  if (preset === "custom" && from && to) {
    params.set("from", from);
    params.set("to", to);
  } else params.set("preset", preset === "custom" ? "today" : preset);

  return {
    scope,
    id,
    preset,
    from: from || null,
    to: to || null,
    groupBy,
    compare: compare === "1",
    query: params.toString(),
    scopeLabel,
    hierarchy: hierarchy.data ?? [],
    setScope,
    setPreset: (v) => {
      setPresetRaw(v);
      setGroupByRaw("");
    },
    setRange: (f, t) => {
      setFrom(f);
      setTo(t);
    },
    setGroupBy: (v) => setGroupByRaw(v),
    setCompare: (v) => setCompareRaw(v ? "1" : "0"),
  };
}

export function FilterBar({ f }: { f: ReturnType<typeof useReportFilters> }) {
  const scopeValue = f.id === null ? f.scope : `${f.scope}:${f.id}`;
  return (
    <div className="sticky top-0 z-10 -mx-4 mb-5 border-b border-line bg-page/95 px-4 py-3 backdrop-blur md:-mx-6 md:px-6 lg:-mx-8 lg:px-8">
      <div className="flex flex-wrap items-center gap-3">
        <Select aria-label="Kapsam" value={scopeValue} onChange={(e) => f.setScope(e.target.value)} className="w-auto min-w-48">
          <option value="plant">Tüm fabrika</option>
          {f.hierarchy.map((a) => (
            <optgroup key={a.id} label={a.name}>
              <option value={`area:${a.id}`}>{a.name} (alan)</option>
              {a.lines.map((l) => (
                <option key={l.id} value={`line:${l.id}`}>
                  {"  "}
                  {l.name}
                </option>
              ))}
              {a.lines.flatMap((l) =>
                l.machines.map((m) => (
                  <option key={m.id} value={`machine:${m.id}`}>
                    {"    "}
                    {m.name} ({m.code})
                  </option>
                )),
              )}
            </optgroup>
          ))}
        </Select>

        <Segmented label="Zaman aralığı" value={f.preset} options={PRESETS.map((p) => ({ value: p.value, label: p.label }))} onChange={f.setPreset} />

        {f.preset === "custom" && (
          <div className="flex items-center gap-2">
            <CalendarRange className="size-4 text-muted" aria-hidden />
            <Input
              type="datetime-local"
              aria-label="Başlangıç"
              className="w-auto"
              value={f.from ? isoToLocalInput(f.from) : ""}
              onChange={(e) => e.target.value && f.setRange(localInputToIso(e.target.value), f.to ?? new Date().toISOString())}
            />
            <span className="text-muted">–</span>
            <Input
              type="datetime-local"
              aria-label="Bitiş"
              className="w-auto"
              value={f.to ? isoToLocalInput(f.to) : ""}
              onChange={(e) => e.target.value && f.setRange(f.from ?? new Date(Date.now() - 86_400_000).toISOString(), localInputToIso(e.target.value))}
            />
          </div>
        )}

        <Segmented
          label="Dönem"
          value={f.groupBy}
          options={[
            { value: "hour", label: "Saat" },
            { value: "shift", label: "Vardiya" },
            { value: "day", label: "Gün" },
            { value: "week", label: "Hafta" },
          ]}
          onChange={(v) => f.setGroupBy(v as GroupBy)}
        />

        <Checkbox label="Önceki dönemle karşılaştır" checked={f.compare} onChange={(e) => f.setCompare(e.target.checked)} />
      </div>
    </div>
  );
}
