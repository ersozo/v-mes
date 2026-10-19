import { describe, expect, it } from "vitest";
import { CounterTracker, minuteBucket } from "../src/counters.js";

const t = (s: number) => new Date(Date.UTC(2026, 9, 19, 8, 0, 0) + s * 1000);

describe("CounterTracker", () => {
  it("ilk örnek yalnızca başlangıç değeridir, sonrakiler fark üretir", () => {
    const c = new CounterTracker(10_000);
    expect(c.observe(1, "total_count", 1000, t(0))).toEqual({ delta: 0 });
    expect(c.observe(1, "total_count", 1003, t(1))).toEqual({ delta: 3 });
    expect(c.observe(1, "total_count", 1003, t(2))).toEqual({ delta: 0 });
  });

  it("sayaç sıfırlanmasında yeni değeri artış sayar (max−min hatasına düşmez)", () => {
    const c = new CounterTracker(10_000);
    c.observe(1, "total_count", 5000, t(0));
    c.observe(1, "total_count", 5010, t(10));
    expect(c.observe(1, "total_count", 4, t(20))).toEqual({ delta: 4, event: "reset" });
    c.observe(1, "total_count", 9, t(30));
    const { deltas } = c.drain();
    expect(deltas.reduce((s, d) => s + d.delta, 0)).toBe(10 + 4 + 5);
  });

  it("önceki değere yakın bir değere geri düşüş sıfırlanma değil anomalidir", () => {
    // Örn. PLC programı eski bir değerle yeniden yüklendi: 3.100 → 3.046 (3.046 adet "üretim" değildir)
    const c = new CounterTracker(10_000);
    c.observe(1, "scrap_count", 3100, t(0));
    expect(c.observe(1, "scrap_count", 3046, t(1))).toEqual({ delta: 0, event: "anomaly" });
    expect(c.observe(1, "scrap_count", 3047, t(2))).toEqual({ delta: 1 });
    // WORD taşması (65535 → 5) gerçek bir sıfırlanmadır
    c.observe(2, "total_count", 65530, t(0));
    expect(c.observe(2, "total_count", 5, t(1))).toEqual({ delta: 5, event: "reset" });
  });

  it("16 bit (WORD/UInt) sayaç taşmasında aradaki adetleri kaybetmez", () => {
    const c = new CounterTracker(10_000);
    c.observe(1, "total_count", 65_530, t(0), 65_536);
    // 65530 → 65535 → 0 → 4: gerçek artış 6 + 4 = 10
    expect(c.observe(1, "total_count", 4, t(1), 65_536)).toEqual({ delta: 10, event: "wrap" });
    expect(c.observe(1, "total_count", 7, t(2), 65_536)).toEqual({ delta: 3 });
  });

  it("işaretsiz sayaçta üst sınırdan uzakta sıfıra düşüş taşma değil sıfırlanmadır", () => {
    const c = new CounterTracker(10_000);
    c.observe(1, "total_count", 60_000, t(0), 65_536);
    // taşma sayılsaydı 5.536 + 2 adet yazılırdı
    expect(c.observe(1, "total_count", 2, t(1), 65_536)).toEqual({ delta: 2, event: "reset" });
  });

  it("aşırı sıçramaları anomali olarak işaretler ve saymaz", () => {
    const c = new CounterTracker(100);
    c.observe(1, "total_count", 10, t(0));
    expect(c.observe(1, "total_count", 999_999, t(1))).toEqual({ delta: 0, event: "anomaly" });
    expect(c.observe(1, "total_count", 1_000_002, t(2))).toEqual({ delta: 3 });
  });

  it("tekrar eden veya geç gelen örnekleri yok sayar", () => {
    const c = new CounterTracker(10_000);
    c.observe(1, "total_count", 10, t(5));
    expect(c.observe(1, "total_count", 12, t(5))).toBeNull();
    expect(c.observe(1, "total_count", 8, t(3))).toBeNull();
    expect(c.observe(1, "total_count", 12, t(6))).toEqual({ delta: 2 });
  });

  it("negatif ve tamsayı olmayan değerleri geçersiz sayar", () => {
    const c = new CounterTracker(10_000);
    expect(c.observe(1, "total_count", -5, t(0))).toEqual({ delta: 0, event: "invalid" });
    expect(c.observe(1, "total_count", 1.5, t(0))).toEqual({ delta: 0, event: "invalid" });
  });

  it("farkları dakika kovalarına, makine ve role göre toplar", () => {
    const c = new CounterTracker(10_000);
    c.observe(1, "total_count", 0, t(0));
    c.observe(1, "total_count", 2, t(30));
    c.observe(1, "total_count", 5, t(59));
    c.observe(1, "total_count", 6, t(61));
    c.observe(1, "scrap_count", 0, t(0));
    c.observe(1, "scrap_count", 1, t(30));
    c.observe(2, "total_count", 100, t(0));
    c.observe(2, "total_count", 101, t(10));
    const { deltas, states } = c.drain();
    const find = (m: number, role: string, s: number) =>
      deltas.find((d) => d.machineId === m && d.role === role && d.bucket.getTime() === minuteBucket(t(s)).getTime())?.delta;
    expect(find(1, "total_count", 0)).toBe(5);
    expect(find(1, "total_count", 60)).toBe(1);
    expect(find(1, "scrap_count", 0)).toBe(1);
    expect(find(2, "total_count", 0)).toBe(1);
    expect(states).toHaveLength(3);
    expect(c.drain().deltas).toEqual([]);
  });

  it("kalıcı son değerden devam eder ve yazılamayan farkları geri alır", () => {
    const c = new CounterTracker(10_000, [{ machineId: 1, role: "total_count", value: 500, ts: t(0) }]);
    expect(c.observe(1, "total_count", 507, t(10))).toEqual({ delta: 7 });
    const drained = c.drain();
    c.restore(drained.deltas, drained.states);
    c.observe(1, "total_count", 508, t(20));
    expect(c.drain().deltas[0]!.delta).toBe(8);
  });
});
