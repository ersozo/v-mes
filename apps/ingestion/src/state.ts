// Makine durum makinesi: running / stopped / offline ve otomatik duruş kayıtları.
//
// Saf mantık; I/O yapmaz. Girdileri (telemetri, status, heartbeat, zaman tiki) işler ve
// kalıcı hâle getirilecek/yayınlanacak olayları döner. (ARCHITECTURE.md §6.4)
//
// Zaman kuralları:
//  - Telemetriye dayalı geçişler payload zaman damgasını (edge saati) kullanır.
//  - Zaman aşımı kontrolleri sunucu saatiyle yapılır; geçiş anı son görülen telemetri anına
//    geri tarihlenir (verinin kesildiği gerçek an).
//  - Sayaç modunda duruş, son sayaç artışının olduğu ana geri tarihlenir.

export type MachineState = "running" | "stopped" | "offline";

export interface MachineProfile {
  id: number;
  edgeId: string;
  stateSource: "tag" | "counter";
  counterIdleSeconds: number;
  offlineTimeoutMs: number;
}

export interface EngineSettings {
  /** Bu süreden kısa duruşlar downtime kaydı açmaz (mikro duruş). */
  minDowntimeMs: number;
  edgeTimeoutMs: number;
}

export type EngineEvent =
  | { type: "state"; machineId: number; from: MachineState | null; to: MachineState; at: Date }
  | { type: "downtime_open"; machineId: number; start: Date }
  | { type: "downtime_close"; machineId: number; start: Date; end: Date }
  | { type: "edge"; edgeId: string; online: boolean; at: Date };

export interface TelemetrySignals {
  /** running/state_code tag'lerinden çıkarılan çalışma bilgisi (tag modunda). */
  running?: boolean | undefined;
  /** Bu örnekte total_count arttı mı? (sayaç modunda) */
  countIncreased: boolean;
}

interface Runtime {
  state: MachineState | null;
  since: Date | null;
  lastTs: Date | null;
  lastRecv: number | null;
  running: boolean | null;
  lastIncreaseTs: Date | null;
  counterPrimed: boolean;
  statusOnline: boolean | null;
  statusTs: Date | null;
  downtime: { start: Date; persisted: boolean } | null;
}

export interface MachineSnapshot {
  machineId: number;
  state: MachineState | null;
  since: Date | null;
  lastTs: Date | null;
  downtimeStart: Date | null;
}

const newRuntime = (): Runtime => ({
  state: null,
  since: null,
  lastTs: null,
  lastRecv: null,
  running: null,
  lastIncreaseTs: null,
  counterPrimed: false,
  statusOnline: null,
  statusTs: null,
  downtime: null,
});

export class StateEngine {
  private readonly profiles = new Map<number, MachineProfile>();
  private readonly runtimes = new Map<number, Runtime>();
  private readonly heartbeats = new Map<string, number>();
  private readonly edgeOnline = new Map<string, boolean>();

  constructor(
    private settings: EngineSettings,
    private readonly startedAt: number,
  ) {}

  updateSettings(settings: EngineSettings): void {
    this.settings = settings;
  }

  setProfiles(profiles: MachineProfile[]): void {
    this.profiles.clear();
    for (const p of profiles) this.profiles.set(p.id, p);
  }

  /** Servis açılışında veritabanındaki açık durum aralıkları ve açık duruşlarla devam eder. */
  restore(openStates: { machineId: number; state: MachineState; since: Date }[], openDowntimes: { machineId: number; start: Date }[]): void {
    for (const s of openStates) {
      const rt = this.rt(s.machineId);
      rt.state = s.state;
      rt.since = s.since;
    }
    for (const d of openDowntimes) {
      this.rt(d.machineId).downtime = { start: d.start, persisted: true };
    }
    for (const rt of this.runtimes.values()) {
      if (rt.state && rt.state !== "running" && !rt.downtime && rt.since) {
        rt.downtime = { start: rt.since, persisted: false };
      }
    }
  }

  onTelemetry(machineId: number, ts: Date, signals: TelemetrySignals, receivedAt: number): EngineEvent[] {
    const profile = this.profiles.get(machineId);
    if (!profile) return [];
    const rt = this.rt(machineId);

    rt.lastTs = ts;
    rt.lastRecv = receivedAt;
    if (rt.statusOnline === false && (!rt.statusTs || ts > rt.statusTs)) rt.statusOnline = true;
    if (signals.running !== undefined) rt.running = signals.running;

    if (profile.stateSource === "counter") {
      if (!rt.counterPrimed) {
        rt.counterPrimed = true;
        // Açılışta makinenin çalıştığı varsayılır; durum kaydı "stopped/offline" ise varsayım yapılmaz.
        if (rt.state === null || rt.state === "running") rt.lastIncreaseTs = ts;
      }
      if (signals.countIncreased) rt.lastIncreaseTs = ts;
    }

    const desired = this.desiredFromTelemetry(profile, rt);
    return desired ? this.apply(machineId, rt, desired.state, desired.at, receivedAt) : this.checkDowntime(machineId, rt, receivedAt);
  }

  onStatus(machineId: number, online: boolean, ts: Date, receivedAt: number): EngineEvent[] {
    if (!this.profiles.has(machineId)) return [];
    const rt = this.rt(machineId);
    if (rt.statusTs && ts <= rt.statusTs) return [];
    rt.statusOnline = online;
    rt.statusTs = ts;
    // Çevrimiçi bilgisi tek başına çalışma durumunu belirlemez; sonraki telemetri belirler.
    return online ? [] : this.apply(machineId, rt, "offline", ts, receivedAt);
  }

  onHeartbeat(edgeId: string, receivedAt: number): EngineEvent[] {
    this.heartbeats.set(edgeId, receivedAt);
    if (this.edgeOnline.get(edgeId) !== true) {
      this.edgeOnline.set(edgeId, true);
      return [{ type: "edge", edgeId, online: true, at: new Date(receivedAt) }];
    }
    return [];
  }

  /** Periyodik kontrol: veri kesintisi, edge canlılığı ve uzayan duruşların kaydı. */
  tick(now: number): EngineEvent[] {
    const events: EngineEvent[] = [];

    for (const [id, profile] of this.profiles) {
      const rt = this.rt(id);
      const lastRecv = rt.lastRecv ?? this.startedAt;
      if (rt.state !== "offline" && now - lastRecv > profile.offlineTimeoutMs) {
        const at = rt.lastTs ?? rt.since ?? new Date(this.startedAt);
        events.push(...this.apply(id, rt, "offline", at, now));
      } else {
        events.push(...this.checkDowntime(id, rt, now));
      }
    }

    const edges = new Set([...[...this.profiles.values()].map((p) => p.edgeId), ...this.heartbeats.keys()]);
    for (const edgeId of edges) {
      const last = this.heartbeats.get(edgeId) ?? this.startedAt;
      if (now - last > this.settings.edgeTimeoutMs && this.edgeOnline.get(edgeId) !== false) {
        this.edgeOnline.set(edgeId, false);
        events.push({ type: "edge", edgeId, online: false, at: new Date(last) });
      }
    }
    return events;
  }

  snapshot(): MachineSnapshot[] {
    return [...this.profiles.keys()].map((machineId) => {
      const rt = this.rt(machineId);
      return { machineId, state: rt.state, since: rt.since, lastTs: rt.lastTs, downtimeStart: rt.downtime?.persisted ? rt.downtime.start : null };
    });
  }

  edgeStatus(): { edgeId: string; online: boolean }[] {
    return [...this.edgeOnline].map(([edgeId, online]) => ({ edgeId, online }));
  }

  // -------------------------------------------------------------------------

  private rt(machineId: number): Runtime {
    let rt = this.runtimes.get(machineId);
    if (!rt) {
      rt = newRuntime();
      this.runtimes.set(machineId, rt);
    }
    return rt;
  }

  private desiredFromTelemetry(profile: MachineProfile, rt: Runtime): { state: MachineState; at: Date } | null {
    const ts = rt.lastTs!;
    if (rt.statusOnline === false) return null;
    if (profile.stateSource === "tag") {
      if (rt.running === null) return null;
      return { state: rt.running ? "running" : "stopped", at: ts };
    }
    const lastInc = rt.lastIncreaseTs;
    if (lastInc && ts.getTime() - lastInc.getTime() <= profile.counterIdleSeconds * 1000) {
      return { state: "running", at: lastInc };
    }
    return { state: "stopped", at: lastInc ?? ts };
  }

  private apply(machineId: number, rt: Runtime, to: MachineState, at: Date, now: number): EngineEvent[] {
    if (rt.state === to) return this.checkDowntime(machineId, rt, now);

    // Çevrimdışından dönüşte geçiş, verinin yeniden geldiği andır (geri tarihleme yapılmaz).
    if (rt.state === "offline" && rt.lastTs && at < rt.lastTs) at = rt.lastTs;
    // Aralıklar örtüşmesin: geçiş anı mevcut aralığın başlangıcından önce olamaz.
    if (rt.since && at < rt.since) at = rt.since;

    const events: EngineEvent[] = [{ type: "state", machineId, from: rt.state, to, at }];

    if (to === "running") {
      if (rt.downtime?.persisted) {
        events.push({ type: "downtime_close", machineId, start: rt.downtime.start, end: at });
      }
      rt.downtime = null;
    } else if (!rt.downtime) {
      rt.downtime = { start: at, persisted: false };
    }

    rt.state = to;
    rt.since = at;
    events.push(...this.checkDowntime(machineId, rt, now));
    return events;
  }

  private checkDowntime(machineId: number, rt: Runtime, now: number): EngineEvent[] {
    const d = rt.downtime;
    if (d && !d.persisted && now - d.start.getTime() >= this.settings.minDowntimeMs) {
      d.persisted = true;
      return [{ type: "downtime_open", machineId, start: d.start }];
    }
    return [];
  }
}
