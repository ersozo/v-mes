// Kümülatif PLC sayaçlarından artış (delta) hesabı.
//
// Kurallar (ARCHITECTURE.md §6.3):
//   d = yeni − önceki
//   d ≥ 0          → artış
//   d < 0          → yeni değer sıfıra yakınsa (önceki değerin yarısından küçük ve ≤ maxDelta)
//                    sayaç sıfırlanması/taşması: artış = yeni değer;
//                    değilse anomali (ör. PLC programı eski değerle yeniden yüklendi): artış sayılmaz
//   d > maxDelta   → anomali (ör. sayaç ön ayarı, bozuk okuma): artış sayılmaz
// Zamanı geride kalan (tekrar/sıra dışı) örnekler yok sayılır.

export type CounterRole = "total_count" | "scrap_count";

export interface CounterState {
  value: number;
  ts: Date;
}

export type CounterEvent = "reset" | "anomaly" | "invalid";

export interface Observation {
  delta: number;
  event?: CounterEvent;
}

export interface BucketDelta {
  machineId: number;
  bucket: Date;
  role: CounterRole;
  delta: number;
}

export interface StateRow {
  machineId: number;
  role: CounterRole;
  value: number;
  ts: Date;
}

const key = (machineId: number, role: CounterRole) => `${machineId}|${role}`;

export function minuteBucket(ts: Date): Date {
  return new Date(Math.floor(ts.getTime() / 60_000) * 60_000);
}

export class CounterTracker {
  private readonly last = new Map<string, CounterState & { machineId: number; role: CounterRole }>();
  private readonly buckets = new Map<string, BucketDelta>();
  private readonly dirty = new Set<string>();

  constructor(
    private readonly maxDelta: number,
    initial: Iterable<StateRow> = [],
  ) {
    for (const row of initial) {
      this.last.set(key(row.machineId, row.role), { ...row });
    }
  }

  /** Örneği işler; yok sayılan (eski/tekrar) örnekler için null döner. */
  observe(machineId: number, role: CounterRole, value: number, ts: Date): Observation | null {
    if (!Number.isInteger(value) || value < 0) {
      return { delta: 0, event: "invalid" };
    }
    const k = key(machineId, role);
    const prev = this.last.get(k);
    if (prev && ts.getTime() <= prev.ts.getTime()) return null;

    this.last.set(k, { machineId, role, value, ts });
    this.dirty.add(k);
    if (!prev) return { delta: 0 };

    const d = value - prev.value;
    let result: Observation;
    if (d >= 0) {
      result = d > this.maxDelta ? { delta: 0, event: "anomaly" } : { delta: d };
    } else {
      const nearZero = value <= this.maxDelta && value < prev.value / 2;
      result = nearZero ? { delta: value, event: "reset" } : { delta: 0, event: "anomaly" };
    }

    if (result.delta > 0) {
      const bucket = minuteBucket(ts);
      const bk = `${machineId}|${bucket.getTime()}|${role}`;
      const existing = this.buckets.get(bk);
      if (existing) existing.delta += result.delta;
      else this.buckets.set(bk, { machineId, bucket, role, delta: result.delta });
    }
    return result;
  }

  /** Biriken dakikalık artışları ve değişen son değerleri alır (yazma sonrası `restore` ile geri konabilir). */
  drain(): { deltas: BucketDelta[]; states: StateRow[] } {
    const deltas = [...this.buckets.values()];
    const states = [...this.dirty].map((k) => {
      const s = this.last.get(k)!;
      return { machineId: s.machineId, role: s.role, value: s.value, ts: s.ts };
    });
    this.buckets.clear();
    this.dirty.clear();
    return { deltas, states };
  }

  /** Yazılamayan artışları bir sonraki denemeye geri ekler. */
  restore(deltas: BucketDelta[], states: StateRow[]): void {
    for (const d of deltas) {
      const bk = `${d.machineId}|${d.bucket.getTime()}|${d.role}`;
      const existing = this.buckets.get(bk);
      if (existing) existing.delta += d.delta;
      else this.buckets.set(bk, { ...d });
    }
    for (const s of states) this.dirty.add(key(s.machineId, s.role));
  }
}
