// Duruş nedeni atama: büyük dokunmatik düğmeler (operatör tableti), kategoriye göre gruplu.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import { dateTime, duration, time } from "../lib/format";
import type { Downtime, DowntimeReason } from "../lib/types";
import { CATEGORY_META } from "./state";
import { Button, cn, Dialog, ErrorBox, Input } from "./ui";

export function useReasons() {
  return useQuery({ queryKey: ["reasons"], queryFn: () => api<DowntimeReason[]>("/api/downtime-reasons"), staleTime: 300_000 });
}

export function AssignDowntimeDialog({ downtime, onClose }: { downtime: Downtime | null; onClose: () => void }) {
  const reasons = useReasons();
  const qc = useQueryClient();
  const [picked, setPicked] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const save = useMutation({
    mutationFn: () => api(`/api/downtimes/${downtime!.id}`, { method: "PATCH", json: { reason_id: picked, note: note || null } }),
    onSuccess: () => {
      void qc.invalidateQueries();
      setPicked(null);
      setNote("");
      onClose();
    },
  });

  const active = (reasons.data ?? []).filter((r) => r.is_active);
  const groups = (["unplanned", "changeover", "planned"] as const).map((c) => ({ c, items: active.filter((r) => r.category === c) }));

  return (
    <Dialog
      open={!!downtime}
      onClose={onClose}
      wide
      title="Duruş nedeni"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Vazgeç
          </Button>
          <Button variant="primary" size="lg" disabled={picked === null} loading={save.isPending} onClick={() => save.mutate()}>
            Kaydet
          </Button>
        </>
      }
    >
      {downtime && (
        <p className="mb-4 text-ink-2">
          <span className="font-medium text-ink">{downtime.machine_name}</span> · {dateTime(downtime.start_ts)}–{downtime.open ? "devam ediyor" : time(downtime.end_ts)} ·{" "}
          {duration(downtime.duration_seconds)}
        </p>
      )}
      {save.error && <ErrorBox error={save.error} />}
      <div className="space-y-4">
        {groups.map(
          (g) =>
            g.items.length > 0 && (
              <div key={g.c}>
                <div className="mb-2 flex items-center gap-1.5 text-[13px] font-medium text-ink-2">
                  <span style={{ color: CATEGORY_META[g.c].color }}>{CATEGORY_META[g.c].icon}</span>
                  {CATEGORY_META[g.c].label}
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {g.items.map((r) => (
                    <button
                      key={r.id}
                      onClick={() => setPicked(r.id)}
                      aria-pressed={picked === r.id}
                      className={cn(
                        "min-h-14 rounded-xl border border-line bg-surface px-3 py-2 text-left font-medium transition-colors hover:bg-surface-2",
                        picked === r.id && "border-accent bg-[color-mix(in_oklab,var(--accent)_10%,var(--surface))] ring-2 ring-accent",
                      )}
                    >
                      {r.name}
                    </button>
                  ))}
                </div>
              </div>
            ),
        )}
        <Input placeholder="Not (isteğe bağlı)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
      </div>
    </Dialog>
  );
}
