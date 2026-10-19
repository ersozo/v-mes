import { describe, expect, it } from "vitest";
import { StateEngine, type EngineEvent, type MachineProfile } from "../src/state.js";

const T0 = Date.UTC(2026, 9, 19, 8, 0, 0);
const at = (s: number) => new Date(T0 + s * 1000);
const settings = { minDowntimeMs: 60_000, edgeTimeoutMs: 30_000 };

const tagMachine: MachineProfile = { id: 1, edgeId: "edge-01", stateSource: "tag", counterIdleSeconds: 120, offlineTimeoutMs: 30_000 };
const counterMachine: MachineProfile = { id: 2, edgeId: "edge-01", stateSource: "counter", counterIdleSeconds: 30, offlineTimeoutMs: 30_000 };

function engine(...profiles: MachineProfile[]) {
  const e = new StateEngine(settings, T0);
  e.setProfiles(profiles);
  return e;
}

/** Saniyede bir telemetri gönderir (sunucu saati = payload saati). */
function feed(e: StateEngine, id: number, from: number, to: number, sig: (s: number) => { running?: boolean; countIncreased: boolean }) {
  const events: EngineEvent[] = [];
  for (let s = from; s <= to; s++) {
    events.push(...e.onTelemetry(id, at(s), sig(s), T0 + s * 1000));
    events.push(...e.tick(T0 + s * 1000));
  }
  return events;
}

const states = (ev: EngineEvent[]) => ev.filter((e) => e.type === "state").map((e) => e.type === "state" && [e.to, (e.at.getTime() - T0) / 1000]);
const ofType = (ev: EngineEvent[], type: EngineEvent["type"]) => ev.filter((e) => e.type === type);

describe("durum makinesi — tag modu", () => {
  it("running tag'ine göre geçiş yapar", () => {
    const e = engine(tagMachine);
    const ev = feed(e, 1, 0, 20, (s) => ({ running: s < 10, countIncreased: false }));
    expect(states(ev)).toEqual([["running", 0], ["stopped", 10]]);
  });

  it("mikro duruş downtime kaydı açmaz, uzun duruş açar ve kapatır", () => {
    const e = engine(tagMachine);
    // 0–9 çalışıyor, 10–39 kısa duruş (30 sn), 40–99 çalışıyor, 100–200 uzun duruş, 201+ çalışıyor
    const ev = feed(e, 1, 0, 230, (s) => ({ running: s < 10 || (s >= 40 && s < 100) || s > 200, countIncreased: false }));
    const opens = ofType(ev, "downtime_open");
    const closes = ofType(ev, "downtime_close");
    expect(opens).toHaveLength(1);
    expect(opens[0]).toMatchObject({ start: at(100) });
    expect(closes).toEqual([{ type: "downtime_close", machineId: 1, start: at(100), end: at(201) }]);
  });
});

describe("durum makinesi — sayaç modu", () => {
  it("sayaç durunca son artış anına geri tarihlenmiş duruş üretir", () => {
    const e = engine(counterMachine);
    // her 3 sn'de bir parça, 60. sn'den sonra üretim yok
    const ev = feed(e, 2, 0, 120, (s) => ({ countIncreased: s % 3 === 0 && s <= 60 }));
    expect(states(ev)).toEqual([["running", 0], ["stopped", 60]]);
    // 60 sn'lik eşik 120. sn'de aşılır; downtime başlangıcı 60. sn'dir
    expect(ofType(ev, "downtime_open")).toEqual([{ type: "downtime_open", machineId: 2, start: at(60) }]);
  });

  it("üretim yeniden başlayınca çalışıyor durumuna döner", () => {
    const e = engine(counterMachine);
    const ev = feed(e, 2, 0, 200, (s) => ({ countIncreased: s % 3 === 0 && (s <= 60 || s >= 150) }));
    expect(states(ev)).toEqual([["running", 0], ["stopped", 60], ["running", 150]]);
    expect(ofType(ev, "downtime_close")).toEqual([{ type: "downtime_close", machineId: 2, start: at(60), end: at(150) }]);
  });
});

describe("durum makinesi — çevrimdışı", () => {
  it("veri kesilince son veri anına geri tarihli offline olur, veri gelince döner", () => {
    const e = engine(tagMachine);
    const ev: EngineEvent[] = feed(e, 1, 0, 50, () => ({ running: true, countIncreased: false }));
    for (let s = 51; s <= 120; s++) ev.push(...e.tick(T0 + s * 1000)); // veri yok
    ev.push(...feed(e, 1, 121, 125, () => ({ running: true, countIncreased: false })));
    expect(states(ev)).toEqual([["running", 0], ["offline", 50], ["running", 121]]);
    expect(ofType(ev, "downtime_close")).toEqual([{ type: "downtime_close", machineId: 1, start: at(50), end: at(121) }]);
  });

  it("status online=false anında offline yapar; duruş offline→stopped boyunca tek kayıttır", () => {
    const e = engine(tagMachine);
    const ev: EngineEvent[] = feed(e, 1, 0, 10, () => ({ running: true, countIncreased: false }));
    ev.push(...e.onStatus(1, false, at(11), T0 + 11_000));
    for (let s = 12; s <= 40; s++) ev.push(...e.tick(T0 + s * 1000));
    ev.push(...e.onStatus(1, true, at(41), T0 + 41_000));
    ev.push(...feed(e, 1, 42, 100, (s) => ({ running: s > 90, countIncreased: false })));
    expect(states(ev)).toEqual([["running", 0], ["offline", 11], ["stopped", 42], ["running", 91]]);
    expect(ofType(ev, "downtime_open")).toHaveLength(1);
    expect(ofType(ev, "downtime_close")).toEqual([{ type: "downtime_close", machineId: 1, start: at(11), end: at(91) }]);
  });

  it("hiç veri gelmeyen makine zaman aşımından sonra offline olur", () => {
    const e = engine(tagMachine);
    const ev: EngineEvent[] = [];
    for (let s = 0; s <= 31; s++) ev.push(...e.tick(T0 + s * 1000));
    expect(states(ev)).toEqual([["offline", 0]]);
  });
});

describe("durum makinesi — yeniden başlatma ve edge", () => {
  it("veritabanındaki açık aralık ve duruşla kaldığı yerden devam eder", () => {
    const e = engine(tagMachine);
    e.restore([{ machineId: 1, state: "stopped", since: at(-300) }], [{ machineId: 1, start: at(-300) }]);
    const ev = feed(e, 1, 0, 5, (s) => ({ running: s >= 3, countIncreased: false }));
    expect(states(ev)).toEqual([["running", 3]]);
    expect(ofType(ev, "downtime_close")).toEqual([{ type: "downtime_close", machineId: 1, start: at(-300), end: at(3) }]);
  });

  it("aynı durumu tekrar bildirmez", () => {
    const e = engine(tagMachine);
    e.restore([{ machineId: 1, state: "running", since: at(-100) }], []);
    expect(states(feed(e, 1, 0, 30, () => ({ running: true, countIncreased: false })))).toEqual([]);
  });

  it("edge heartbeat kesilince ve gelince olay üretir", () => {
    const e = engine(tagMachine);
    expect(e.onHeartbeat("edge-01", T0)).toMatchObject([{ type: "edge", online: true }]);
    expect(e.onHeartbeat("edge-01", T0 + 10_000)).toEqual([]);
    expect(e.tick(T0 + 41_000).filter((x) => x.type === "edge")).toMatchObject([{ edgeId: "edge-01", online: false }]);
    expect(e.onHeartbeat("edge-01", T0 + 50_000)).toMatchObject([{ type: "edge", online: true }]);
  });
});
