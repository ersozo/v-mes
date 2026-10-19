// Makine durumu ve duruş kategorisi gösterimi: renk her zaman ikon + etiketle birlikte (renk tek başına anlam taşımaz).
import { CircleCheck, CircleHelp, CirclePause, Hammer, PlugZap, RefreshCw, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import type { MachineState } from "../lib/types";
import { cn } from "./ui";

export const STATE_META: Record<MachineState | "unknown", { label: string; color: string; icon: ReactNode }> = {
  running: { label: "Çalışıyor", color: "var(--state-running)", icon: <CircleCheck className="size-3.5" aria-hidden /> },
  stopped: { label: "Duruyor", color: "var(--state-stopped)", icon: <CirclePause className="size-3.5" aria-hidden /> },
  offline: { label: "Bağlantı yok", color: "var(--state-offline)", icon: <PlugZap className="size-3.5" aria-hidden /> },
  unknown: { label: "Bilinmiyor", color: "var(--state-offline)", icon: <CircleHelp className="size-3.5" aria-hidden /> },
};

export type DowntimeCategory = "unplanned" | "planned" | "changeover" | "unassigned";

export const CATEGORY_META: Record<DowntimeCategory, { label: string; color: string; icon: ReactNode }> = {
  unplanned: { label: "Plansız", color: "var(--state-stopped)", icon: <TriangleAlert className="size-3.5" aria-hidden /> },
  planned: { label: "Planlı", color: "var(--state-planned)", icon: <Hammer className="size-3.5" aria-hidden /> },
  changeover: { label: "Ürün/takım değişimi", color: "var(--state-changeover)", icon: <RefreshCw className="size-3.5" aria-hidden /> },
  unassigned: { label: "Nedeni girilmedi", color: "var(--state-unassigned)", icon: <CircleHelp className="size-3.5" aria-hidden /> },
};

export function StateBadge({ state, size = "md" }: { state: MachineState | null | undefined; size?: "md" | "lg" }) {
  const meta = STATE_META[state ?? "unknown"];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-line bg-surface font-medium text-ink",
        size === "md" ? "px-2 py-0.5 text-[12px]" : "px-3 py-1 text-[14px]",
      )}
    >
      <span className="state-dot inline-flex" style={{ color: meta.color }}>
        {meta.icon}
      </span>
      {meta.label}
    </span>
  );
}

export function CategoryTag({ category }: { category: DowntimeCategory }) {
  const meta = CATEGORY_META[category];
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-2">
      <span className="state-dot inline-flex" style={{ color: meta.color }}>
        {meta.icon}
      </span>
      {meta.label}
    </span>
  );
}
