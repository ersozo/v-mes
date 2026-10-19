// MQTT mesajlarını işleyen ana boru hattı: doğrulama → tampon → sayaç farkı → durum makinesi.

import {
  heartbeatPayloadSchema,
  parseTopic,
  statusPayloadSchema,
  tagValueToNumber,
  telemetryPayloadSchema,
} from "@vmes/contracts";
import type { Config } from "./config.js";
import { CounterTracker, type CounterRole } from "./counters.js";
import type { Logger } from "./logger.js";
import type { MachineScope, Realtime } from "./realtime.js";
import { StateEngine, type EngineEvent, type MachineProfile } from "./state.js";
import type { MachineRecord, Store, TelemetryRow } from "./store.js";

const COUNTER_ROLES: ReadonlySet<string> = new Set(["total_count", "scrap_count"]);
/** Edge saati sunucudan bu kadar saparsa uyarı verilir (zaman damgaları edge'de atanır). */
const CLOCK_SKEW_WARN_MS = 30_000;

export interface IngestStats {
  received: number;
  rejected: number;
  duplicates: number;
  droppedRows: number;
  bufferedRows: number;
  lastFlushAt: string | null;
  lastFlushError: string | null;
  pendingDbOps: number;
  edgeClockSkewSeconds: Record<string, number>;
}

export class Ingestor {
  private machinesByCode = new Map<string, MachineRecord>();
  private machinesById = new Map<number, MachineRecord>();
  private lastTsByMachine = new Map<number, number>();
  private buffer: TelemetryRow[] = [];
  private flushing = false;
  private dbQueue: Promise<void> = Promise.resolve();
  private pendingDbOps = 0;
  private readonly stats = { received: 0, rejected: 0, duplicates: 0, droppedRows: 0 };
  private lastFlushAt: Date | null = null;
  private lastFlushError: string | null = null;
  private realtime: Realtime | null = null;
  /** edge_id → sunucu saati − edge saati (ms; pozitif = edge geride). Heartbeat'lerden, kayan ortalama. */
  private readonly clockSkew = new Map<string, number>();

  private constructor(
    private readonly cfg: Config,
    private readonly store: Store,
    private readonly counters: CounterTracker,
    private readonly engine: StateEngine,
    private readonly log: Logger,
  ) {}

  static async create(cfg: Config, store: Store, log: Logger, now = Date.now()): Promise<Ingestor> {
    const settings = await store.loadSettings();
    const counters = new CounterTracker(cfg.COUNTER_MAX_DELTA, await store.loadCounterState());
    const engine = new StateEngine(
      { minDowntimeMs: settings.minDowntimeSeconds * 1000, edgeTimeoutMs: settings.edgeHeartbeatTimeoutSeconds * 1000 },
      now,
    );
    const ingestor = new Ingestor(cfg, store, counters, engine, log);
    await ingestor.refreshRegistry();
    engine.restore(await store.loadOpenStates(), await store.loadOpenDowntimes());
    return ingestor;
  }

  attachRealtime(realtime: Realtime): void {
    this.realtime = realtime;
  }

  async refreshRegistry(): Promise<void> {
    const [{ machines, invalid }, settings] = await Promise.all([this.store.loadMachines(), this.store.loadSettings()]);
    for (const bad of invalid) this.log.warn({ machine: bad.code, error: bad.error }, "geçersiz tag konfigürasyonu; makine atlandı");
    this.machinesByCode = new Map(machines.map((m) => [m.code, m]));
    this.machinesById = new Map(machines.map((m) => [m.id, m]));
    this.engine.setProfiles(machines.map(toProfile));
    this.engine.updateSettings({
      minDowntimeMs: settings.minDowntimeSeconds * 1000,
      edgeTimeoutMs: settings.edgeHeartbeatTimeoutSeconds * 1000,
    });
  }

  // --- Mesaj işleme --------------------------------------------------------

  handleMessage(topic: string, raw: Buffer, now = Date.now()): void {
    this.stats.received++;
    const parsedTopic = parseTopic(topic);
    if (!parsedTopic) return this.reject(topic, raw, "UNS kalıbına uymayan topic");

    let json: unknown;
    try {
      json = JSON.parse(raw.toString("utf8"));
    } catch {
      return this.reject(topic, raw, "geçersiz JSON");
    }

    if (parsedTopic.kind === "heartbeat") {
      const hb = heartbeatPayloadSchema.safeParse(json);
      if (!hb.success || hb.data.edge_id !== parsedTopic.edgeId) return this.reject(topic, raw, "geçersiz heartbeat");
      this.trackClock(hb.data.edge_id, now - new Date(hb.data.ts).getTime());
      return this.handleEvents(this.engine.onHeartbeat(hb.data.edge_id, now));
    }

    const machine = this.machinesByCode.get(parsedTopic.machine);
    if (!machine) return this.reject(topic, raw, `kayıtlı/aktif olmayan makine: ${parsedTopic.machine}`);
    if (machine.areaSlug !== parsedTopic.area || machine.lineSlug !== parsedTopic.line) {
      return this.reject(topic, raw, `topic hiyerarşisi kayıtla uyuşmuyor (beklenen ${machine.areaSlug}/${machine.lineSlug})`);
    }

    if (parsedTopic.kind === "status") {
      const st = statusPayloadSchema.safeParse(json);
      if (!st.success || st.data.machine_code !== machine.code) return this.reject(topic, raw, "geçersiz status");
      return this.handleEvents(this.engine.onStatus(machine.id, st.data.online, new Date(st.data.ts), now));
    }

    const tm = telemetryPayloadSchema.safeParse(json);
    if (!tm.success) return this.reject(topic, raw, tm.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    if (tm.data.machine_code !== machine.code) return this.reject(topic, raw, "payload machine_code topic ile uyuşmuyor");

    const ts = new Date(tm.data.ts);
    if (ts.getTime() > now + this.cfg.MAX_CLOCK_SKEW_MS) return this.reject(topic, raw, "zaman damgası ileri tarihli (edge saati?)");
    const last = this.lastTsByMachine.get(machine.id);
    if (last !== undefined && ts.getTime() <= last) {
      this.stats.duplicates++;
      return;
    }
    this.lastTsByMachine.set(machine.id, ts.getTime());

    let countIncreased = false;
    let running: boolean | undefined;
    let stateCode: number | undefined;
    const tags: Record<string, number> = {};

    for (const [name, rawValue] of Object.entries(tm.data.tags)) {
      const value = tagValueToNumber(rawValue);
      tags[name] = value;
      this.buffer.push({ machineId: machine.id, tag: name, ts, value });

      const role = machine.tagRoles.get(name);
      if (role && COUNTER_ROLES.has(role)) {
        const obs = this.counters.observe(machine.id, role as CounterRole, value, ts);
        if (obs?.event) this.log.warn({ machine: machine.code, tag: name, value, event: obs.event }, "sayaç olayı");
        if (role === "total_count" && obs && obs.delta > 0) countIncreased = true;
      } else if (role === "running") {
        running = value !== 0;
      } else if (role === "state_code") {
        stateCode = value;
      }
    }
    // running tag'i varsa öncelikli; yoksa state_code = 1 çalışıyor demektir.
    if (running === undefined && stateCode !== undefined) running = stateCode === 1;

    this.trimBuffer();
    this.realtime?.telemetry(scopeOf(machine), { machine_id: machine.id, code: machine.code, ts: tm.data.ts, tags });
    this.handleEvents(this.engine.onTelemetry(machine.id, ts, { running, countIncreased }, now));

    if (this.buffer.length >= this.cfg.FLUSH_MAX_ROWS) void this.flush();
  }

  /**
   * Heartbeat'ten edge saat kaymasını izler (ağ gecikmesi ihmal edilebilir). Eşik aşılınca/geri dönünce
   * log ve canlı "edge_clock" olayı üretir. Kayma, zaman damgalarını (duruş başlangıcı, dakika kovaları)
   * doğrudan bozduğu için görünür olmalıdır.
   */
  private trackClock(edgeId: string, sampleMs: number): void {
    const prev = this.clockSkew.get(edgeId);
    const skew = prev === undefined ? sampleMs : prev * 0.8 + sampleMs * 0.2;
    this.clockSkew.set(edgeId, skew);
    const wasBad = prev !== undefined && Math.abs(prev) > CLOCK_SKEW_WARN_MS;
    const isBad = Math.abs(skew) > CLOCK_SKEW_WARN_MS;
    if (isBad !== wasBad || prev === undefined) {
      if (isBad) this.log.warn({ edge: edgeId, skewSeconds: Math.round(skew / 1000) }, "edge saati sunucudan sapmış (NTP kontrol edin)");
      this.realtime?.emit("edge_clock", null, { edge_id: edgeId, skew_seconds: Math.round(skew / 1000), ok: !isBad });
    }
  }

  tick(now = Date.now()): void {
    this.handleEvents(this.engine.tick(now));
  }

  private reject(topic: string, raw: Buffer, error: string): void {
    this.stats.rejected++;
    this.log.warn({ topic, error }, "mesaj reddedildi");
    this.enqueueDb("dead-letter", () => this.store.insertDeadLetter(topic, raw.toString("utf8"), error), 3);
  }

  private trimBuffer(): void {
    const overflow = this.buffer.length - this.cfg.BUFFER_MAX_ROWS;
    if (overflow > 0) {
      this.buffer.splice(0, overflow);
      this.stats.droppedRows += overflow;
      this.log.error({ dropped: overflow }, "tampon dolu; en eski telemetri satırları atıldı");
    }
  }

  // --- Durum olayları --------------------------------------------------------

  private handleEvents(events: EngineEvent[]): void {
    for (const ev of events) {
      if (ev.type === "edge") {
        this.log.info({ edge: ev.edgeId, online: ev.online }, "edge durumu");
        this.realtime?.emit("edge", null, { edge_id: ev.edgeId, online: ev.online, at: ev.at.toISOString() });
        continue;
      }
      const machine = this.machinesById.get(ev.machineId);
      if (!machine) continue;
      const scope = scopeOf(machine);

      if (ev.type === "state") {
        this.log.info({ machine: machine.code, from: ev.from, to: ev.to, at: ev.at.toISOString() }, "durum değişti");
        this.enqueueDb("state", () => this.store.changeState(ev.machineId, ev.to, ev.at));
        this.realtime?.emit("state", scope, { machine_id: ev.machineId, code: machine.code, state: ev.to, since: ev.at.toISOString() });
      } else if (ev.type === "downtime_open") {
        this.enqueueDb("downtime-open", async () => {
          const id = await this.store.openDowntime(ev.machineId, ev.start);
          this.realtime?.emit("downtime_opened", scope, { id, machine_id: ev.machineId, code: machine.code, start: ev.start.toISOString() });
        });
      } else {
        this.enqueueDb("downtime-close", async () => {
          const id = await this.store.closeDowntime(ev.machineId, ev.end);
          this.realtime?.emit("downtime_closed", scope, {
            id, machine_id: ev.machineId, code: machine.code, start: ev.start.toISOString(), end: ev.end.toISOString(),
          });
        });
      }
    }
  }

  /**
   * Durum/duruş yazımlarını sırayla uygular (sıra önemli: aralık kapat → yeni aralık aç).
   * Başarısız işlem, DB geri gelene kadar artan aralıklarla yeniden denenir.
   */
  private enqueueDb(label: string, op: () => Promise<unknown>, maxAttempts = Number.POSITIVE_INFINITY): void {
    this.pendingDbOps++;
    this.dbQueue = this.dbQueue.then(async () => {
      for (let attempt = 1; ; attempt++) {
        try {
          await op();
          break;
        } catch (err) {
          if (attempt >= maxAttempts) {
            this.log.error({ err, label }, "DB işlemi başarısız; vazgeçildi");
            break;
          }
          const wait = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
          this.log.error({ err, label, attempt, wait }, "DB işlemi başarısız; yeniden denenecek");
          await new Promise((r) => setTimeout(r, wait));
        }
      }
      this.pendingDbOps--;
    });
  }

  // --- Toplu yazım ----------------------------------------------------------

  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    const rows = this.buffer;
    this.buffer = [];
    const { deltas, states } = this.counters.drain();
    try {
      await this.store.insertTelemetry(rows);
    } catch (err) {
      this.buffer = rows.concat(this.buffer);
      this.trimBuffer();
      this.counters.restore(deltas, states);
      this.lastFlushError = String(err);
      this.log.error({ err, rows: rows.length }, "telemetri yazılamadı; tamponda tutuluyor");
      this.flushing = false;
      return;
    }
    try {
      await this.store.upsertCounters(deltas, states);
      this.lastFlushAt = new Date();
      this.lastFlushError = null;
    } catch (err) {
      this.counters.restore(deltas, states);
      this.lastFlushError = String(err);
      this.log.error({ err }, "sayaç farkları yazılamadı; bir sonraki denemede tekrar");
    } finally {
      this.flushing = false;
    }
  }

  /** Kapanışta bekleyen her şeyi yazar. */
  async drain(): Promise<void> {
    await this.flush();
    await this.dbQueue;
  }

  // --- Durum bilgisi --------------------------------------------------------

  getStats(): IngestStats {
    return {
      ...this.stats,
      edgeClockSkewSeconds: Object.fromEntries([...this.clockSkew].map(([k, v]) => [k, Math.round(v / 1000)])),
      bufferedRows: this.buffer.length,
      lastFlushAt: this.lastFlushAt?.toISOString() ?? null,
      lastFlushError: this.lastFlushError,
      pendingDbOps: this.pendingDbOps,
    };
  }

  snapshot(): unknown {
    return {
      machines: this.engine.snapshot().flatMap((s) => {
        const m = this.machinesById.get(s.machineId);
        if (!m) return [];
        return [{
          machine_id: s.machineId,
          code: m.code,
          line_id: m.lineId,
          state: s.state,
          since: s.since?.toISOString() ?? null,
          last_ts: s.lastTs?.toISOString() ?? null,
          downtime_start: s.downtimeStart?.toISOString() ?? null,
        }];
      }),
      edges: this.engine.edgeStatus().map((e) => {
        const skew = this.clockSkew.get(e.edgeId);
        return { edge_id: e.edgeId, online: e.online, skew_seconds: skew === undefined ? null : Math.round(skew / 1000) };
      }),
    };
  }
}

function scopeOf(m: MachineRecord): MachineScope {
  return { machineId: m.id, lineId: m.lineId };
}

function toProfile(m: MachineRecord): MachineProfile {
  return {
    id: m.id,
    edgeId: m.edgeId,
    stateSource: m.stateSource,
    counterIdleSeconds: m.counterIdleSeconds,
    // ARCHITECTURE.md §6.4: 3 × poll süresi, en az 30 sn
    offlineTimeoutMs: Math.max(3 * m.pollMs, 30_000),
  };
}
