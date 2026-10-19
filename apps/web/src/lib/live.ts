// Socket.io canlı veri deposu (ingestion). Bileşenler useSyncExternalStore ile abone olur.
import { useRef, useSyncExternalStore } from "react";
import { io, type Socket } from "socket.io-client";
import { getAccessToken, onAuthChange, refreshSession } from "./api";
import type { MachineState } from "./types";

export interface LiveMachine {
  machine_id: number;
  code: string;
  line_id?: number;
  state: MachineState | null;
  since: string | null;
  last_ts: string | null;
  downtime_start: string | null;
  tags: Record<string, number>;
  tags_ts: string | null;
  /** Son ~2 dakikalık total_count örnekleri (anlık hız için) */
  counts: { t: number; v: number }[];
}

interface LiveState {
  connected: boolean;
  machines: Record<number, LiveMachine>;
  edges: Record<string, boolean>;
  /** Her duruş açılıp kapandığında artar (sorguları tazelemek için) */
  downtimeVersion: number;
}

let state: LiveState = { connected: false, machines: {}, edges: {}, downtimeVersion: 0 };
const subs = new Set<() => void>();
let socket: Socket | null = null;

function set(update: (s: LiveState) => LiveState): void {
  state = update(state);
  subs.forEach((fn) => fn());
}

function blank(id: number, code: string): LiveMachine {
  return { machine_id: id, code, state: null, since: null, last_ts: null, downtime_start: null, tags: {}, tags_ts: null, counts: [] };
}

function patchMachine(id: number, code: string, patch: Partial<LiveMachine>): void {
  set((s) => ({ ...s, machines: { ...s.machines, [id]: { ...(s.machines[id] ?? blank(id, code)), ...patch } } }));
}

function connect(token: string): void {
  socket?.close();
  socket = io({ path: "/socket.io", transports: ["websocket"], auth: (cb) => cb({ token: getAccessToken() ?? token }) });

  socket.on("connect", () => {
    set((s) => ({ ...s, connected: true }));
    socket?.emit("subscribe", { room: "plant" });
  });
  socket.on("disconnect", () => set((s) => ({ ...s, connected: false })));
  socket.on("connect_error", async (err) => {
    set((s) => ({ ...s, connected: false }));
    // Token süresi dolduysa yenile; socket.io kendisi yeniden dener
    if (err.message === "unauthorized") await refreshSession();
  });

  socket.on("snapshot", (snap: { machines: Omit<LiveMachine, "tags" | "tags_ts" | "counts">[]; edges: { edge_id: string; online: boolean }[]; telemetry: Record<string, { ts: string; tags: Record<string, number> }> }) => {
    set((s) => {
      const machines = { ...s.machines };
      for (const m of snap.machines) {
        const t = snap.telemetry[m.machine_id];
        machines[m.machine_id] = { ...(machines[m.machine_id] ?? blank(m.machine_id, m.code)), ...m, tags: t?.tags ?? {}, tags_ts: t?.ts ?? null };
      }
      return { ...s, machines, edges: Object.fromEntries(snap.edges.map((e) => [e.edge_id, e.online])) };
    });
  });

  socket.on("telemetry", (t: { machine_id: number; code: string; ts: string; tags: Record<string, number> }) => {
    const prev = state.machines[t.machine_id];
    const now = new Date(t.ts).getTime();
    const counts = [...(prev?.counts ?? []), ...(t.tags.total_count !== undefined ? [{ t: now, v: t.tags.total_count }] : [])].filter(
      (c) => now - c.t <= 120_000,
    );
    patchMachine(t.machine_id, t.code, { tags: t.tags, tags_ts: t.ts, last_ts: t.ts, counts });
  });

  socket.on("state", (e: { machine_id: number; code: string; state: MachineState; since: string }) => {
    patchMachine(e.machine_id, e.code, { state: e.state, since: e.since, ...(e.state === "running" ? { downtime_start: null } : {}) });
  });
  socket.on("downtime_opened", (e: { machine_id: number; code: string; start: string }) => {
    patchMachine(e.machine_id, e.code, { downtime_start: e.start });
    set((s) => ({ ...s, downtimeVersion: s.downtimeVersion + 1 }));
  });
  socket.on("downtime_closed", (e: { machine_id: number; code: string }) => {
    patchMachine(e.machine_id, e.code, { downtime_start: null });
    set((s) => ({ ...s, downtimeVersion: s.downtimeVersion + 1 }));
  });
  socket.on("edge", (e: { edge_id: string; online: boolean }) => set((s) => ({ ...s, edges: { ...s.edges, [e.edge_id]: e.online } })));
}

onAuthChange((user, token) => {
  if (user && token) {
    if (!socket) connect(token);
  } else {
    socket?.close();
    socket = null;
    set(() => ({ connected: false, machines: {}, edges: {}, downtimeVersion: 0 }));
  }
});

const subscribe = (fn: () => void) => {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
};

/** Seçici sonucu, depo (ve `key`) değişmediği sürece önbellekten döner; yeni dizi/nesne üreten seçiciler güvenlidir.
 *  Seçici bir prop'a bağlıysa (ör. makine id) onu `key` olarak verin. */
export function useLive<T>(selector: (s: LiveState) => T, key: unknown = null): T {
  const cache = useRef<{ state: LiveState; key: unknown; value: T } | null>(null);
  return useSyncExternalStore(subscribe, () => {
    if (cache.current?.state !== state || cache.current.key !== key) cache.current = { state, key, value: selector(state) };
    return cache.current.value;
  });
}

/** Son örneklerden dakikadaki adet (yeterli veri yoksa null). Sayaç sıfırlanmasını yok sayar. */
export function ratePerMinute(m: LiveMachine | undefined): number | null {
  const c = m?.counts ?? [];
  if (c.length < 2) return null;
  const first = c[0]!;
  const last = c[c.length - 1]!;
  const dt = (last.t - first.t) / 60_000;
  if (dt < 0.25 || last.v < first.v) return null;
  return (last.v - first.v) / dt;
}
