// MSSQL erişimi: makine kaydı, toplu telemetri yazımı, sayaç farkları ve durum/duruş kayıtları.

import sql from "mssql";
import { tagListSchema, type TagRole } from "@vmes/contracts";
import type { Config } from "./config.js";
import type { BucketDelta, CounterRole, StateRow } from "./counters.js";
import type { MachineState } from "./state.js";

export interface MachineRecord {
  id: number;
  code: string;
  lineId: number;
  areaSlug: string;
  lineSlug: string;
  edgeId: string;
  stateSource: "tag" | "counter";
  counterIdleSeconds: number;
  scrapSource: "plc" | "manual";
  pollMs: number;
  /** tag adı → rol */
  tagRoles: Map<string, TagRole>;
}

export interface PlantSettings {
  minDowntimeSeconds: number;
  edgeHeartbeatTimeoutSeconds: number;
}

export interface TelemetryRow {
  machineId: number;
  tag: string;
  ts: Date;
  value: number;
}

export class Store {
  private constructor(private readonly pool: sql.ConnectionPool) {}

  static async connect(cfg: Config): Promise<Store> {
    const pool = new sql.ConnectionPool({
      server: cfg.MSSQL_HOST,
      port: cfg.MSSQL_PORT,
      database: cfg.MSSQL_DB,
      user: cfg.MSSQL_APP_USER,
      password: cfg.MSSQL_APP_PASSWORD,
      pool: { max: 5, min: 1, idleTimeoutMillis: 60_000 },
      options: { encrypt: false, trustServerCertificate: true, useUTC: true },
      requestTimeout: 30_000,
    });
    await pool.connect();
    return new Store(pool);
  }

  async close(): Promise<void> {
    await this.pool.close();
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.request().query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  // --- Kayıt (registry) ------------------------------------------------------

  async loadMachines(): Promise<{ machines: MachineRecord[]; invalid: { code: string; error: string }[] }> {
    const r = await this.pool.request().query(`
      SELECT m.id, m.code, m.line_id, a.slug AS area_slug, l.slug AS line_slug, l.edge_id,
             m.state_source, m.counter_idle_seconds, m.scrap_source,
             c.poll_ms, c.tags_json
      FROM dbo.machines m
      JOIN dbo.lines l ON l.id = m.line_id
      JOIN dbo.areas a ON a.id = l.area_id
      JOIN dbo.machine_plc_configs c ON c.machine_id = m.id
      WHERE m.is_active = 1`);

    const machines: MachineRecord[] = [];
    const invalid: { code: string; error: string }[] = [];
    for (const row of r.recordset) {
      const parsed = tagListSchema.safeParse(JSON.parse(row.tags_json));
      if (!parsed.success) {
        invalid.push({ code: row.code, error: parsed.error.issues.map((i) => i.message).join("; ") });
        continue;
      }
      machines.push({
        id: row.id,
        code: row.code,
        lineId: row.line_id,
        areaSlug: row.area_slug,
        lineSlug: row.line_slug,
        edgeId: row.edge_id,
        stateSource: row.state_source,
        counterIdleSeconds: row.counter_idle_seconds,
        scrapSource: row.scrap_source,
        pollMs: row.poll_ms,
        tagRoles: new Map(parsed.data.map((t) => [t.name, t.role])),
      });
    }
    return { machines, invalid };
  }

  async loadSettings(): Promise<PlantSettings> {
    const r = await this.pool.request().query("SELECT [key], value FROM dbo.plant_settings");
    const map = new Map<string, string>(r.recordset.map((x) => [x.key, x.value]));
    const num = (k: string, d: number) => {
      const v = Number(map.get(k));
      return Number.isFinite(v) && v > 0 ? v : d;
    };
    return {
      minDowntimeSeconds: num("min_downtime_seconds", 60),
      edgeHeartbeatTimeoutSeconds: num("edge_heartbeat_timeout_seconds", 30),
    };
  }

  async loadCounterState(): Promise<StateRow[]> {
    const r = await this.pool.request().query("SELECT machine_id, role, last_value, last_ts FROM dbo.counter_state");
    return r.recordset.map((x) => ({ machineId: x.machine_id, role: x.role as CounterRole, value: Number(x.last_value), ts: x.last_ts }));
  }

  async loadOpenStates(): Promise<{ machineId: number; state: MachineState; since: Date }[]> {
    const r = await this.pool.request().query("SELECT machine_id, state, start_ts FROM dbo.machine_state_intervals WHERE end_ts IS NULL");
    return r.recordset.map((x) => ({ machineId: x.machine_id, state: x.state, since: x.start_ts }));
  }

  async loadOpenDowntimes(): Promise<{ machineId: number; start: Date }[]> {
    const r = await this.pool.request().query("SELECT machine_id, start_ts FROM dbo.downtime_logs WHERE end_ts IS NULL");
    return r.recordset.map((x) => ({ machineId: x.machine_id, start: x.start_ts }));
  }

  // --- Toplu yazım ----------------------------------------------------------

  async insertTelemetry(rows: TelemetryRow[]): Promise<void> {
    if (rows.length === 0) return;
    const table = new sql.Table("dbo.machine_telemetry");
    table.create = false;
    table.columns.add("machine_id", sql.Int, { nullable: false });
    table.columns.add("tag_name", sql.VarChar(64), { nullable: false });
    table.columns.add("ts", sql.DateTime2(3), { nullable: false });
    table.columns.add("value", sql.Float, { nullable: false });
    for (const r of rows) table.rows.add(r.machineId, r.tag, r.ts, r.value);
    await this.pool.request().bulk(table);
  }

  /** Dakikalık farkları ekler (mevcut kovaya toplar) ve son sayaç değerlerini günceller — tek transaction. */
  async upsertCounters(deltas: BucketDelta[], states: StateRow[]): Promise<void> {
    if (deltas.length === 0 && states.length === 0) return;
    const tx = new sql.Transaction(this.pool);
    await tx.begin();
    try {
      if (deltas.length > 0) {
        await new sql.Request(tx).batch(
          "CREATE TABLE #deltas (machine_id int NOT NULL, bucket_ts datetime2(0) NOT NULL, role varchar(16) NOT NULL, delta bigint NOT NULL)",
        );
        const t = new sql.Table("#deltas");
        t.create = false;
        t.columns.add("machine_id", sql.Int, { nullable: false });
        t.columns.add("bucket_ts", sql.DateTime2(0), { nullable: false });
        t.columns.add("role", sql.VarChar(16), { nullable: false });
        t.columns.add("delta", sql.BigInt, { nullable: false });
        for (const d of deltas) t.rows.add(d.machineId, d.bucket, d.role, d.delta);
        await new sql.Request(tx).bulk(t);
        await new sql.Request(tx).batch(`
          MERGE dbo.counter_deltas_1m WITH (HOLDLOCK) AS tgt
          USING (SELECT machine_id, bucket_ts, role, SUM(delta) AS delta FROM #deltas GROUP BY machine_id, bucket_ts, role) AS src
            ON tgt.machine_id = src.machine_id AND tgt.bucket_ts = src.bucket_ts AND tgt.role = src.role
          WHEN MATCHED THEN UPDATE SET delta = tgt.delta + src.delta
          WHEN NOT MATCHED THEN INSERT (machine_id, bucket_ts, role, delta) VALUES (src.machine_id, src.bucket_ts, src.role, src.delta);
          DROP TABLE #deltas;`);
      }
      if (states.length > 0) {
        const req = new sql.Request(tx);
        req.input("json", sql.NVarChar(sql.MAX), JSON.stringify(states.map((s) => ({ m: s.machineId, r: s.role, v: s.value, t: s.ts.toISOString().slice(0, 23) }))));
        await req.query(`
          MERGE dbo.counter_state WITH (HOLDLOCK) AS tgt
          USING (SELECT m, r, v, CAST(t AS datetime2(3)) AS t FROM OPENJSON(@json) WITH (m int, r varchar(16), v bigint, t varchar(30))) AS src
            ON tgt.machine_id = src.m AND tgt.role = src.r
          WHEN MATCHED AND src.t > tgt.last_ts THEN UPDATE SET last_value = src.v, last_ts = src.t
          WHEN NOT MATCHED THEN INSERT (machine_id, role, last_value, last_ts) VALUES (src.m, src.r, src.v, src.t);`);
      }
      await tx.commit();
    } catch (err) {
      await tx.rollback().catch(() => undefined);
      throw err;
    }
  }

  async insertDeadLetter(topic: string, payload: string, error: string): Promise<void> {
    await this.pool
      .request()
      .input("topic", sql.NVarChar(512), topic.slice(0, 512))
      .input("payload", sql.NVarChar(sql.MAX), payload.slice(0, 100_000))
      .input("error", sql.NVarChar(2000), error.slice(0, 2000))
      .query("INSERT INTO dbo.ingest_dead_letters (topic, payload, error) VALUES (@topic, @payload, @error)");
  }

  // --- Durum ve duruş kayıtları --------------------------------------------

  async changeState(machineId: number, to: MachineState, at: Date): Promise<void> {
    await this.pool
      .request()
      .input("m", sql.Int, machineId)
      .input("state", sql.VarChar(16), to)
      .input("at", sql.DateTime2(3), at)
      .query(`
        SET XACT_ABORT ON;
        BEGIN TRAN;
          UPDATE dbo.machine_state_intervals SET end_ts = CASE WHEN start_ts > @at THEN start_ts ELSE @at END
          WHERE machine_id = @m AND end_ts IS NULL;
          INSERT INTO dbo.machine_state_intervals (machine_id, state, start_ts) VALUES (@m, @state, @at);
        COMMIT;`);
  }

  async openDowntime(machineId: number, start: Date): Promise<number | null> {
    const r = await this.pool
      .request()
      .input("m", sql.Int, machineId)
      .input("start", sql.DateTime2(3), start)
      .query(`
        INSERT INTO dbo.downtime_logs (machine_id, start_ts)
        OUTPUT inserted.id
        SELECT @m, @start WHERE NOT EXISTS (SELECT 1 FROM dbo.downtime_logs WHERE machine_id = @m AND end_ts IS NULL);`);
    return r.recordset[0]?.id ?? null;
  }

  async closeDowntime(machineId: number, end: Date): Promise<number | null> {
    const r = await this.pool
      .request()
      .input("m", sql.Int, machineId)
      .input("end", sql.DateTime2(3), end)
      .query(`
        UPDATE dbo.downtime_logs SET end_ts = CASE WHEN start_ts > @end THEN start_ts ELSE @end END
        OUTPUT inserted.id
        WHERE machine_id = @m AND end_ts IS NULL;`);
    return r.recordset[0]?.id ?? null;
  }
}
