import { describe, expect, it } from "vitest";
import { statusPayloadSchema, tagValueToNumber, telemetryPayloadSchema } from "../src/index.js";

const valid = {
  v: 1,
  machine_code: "cnc-01",
  ts: "2026-10-19T08:15:30.120Z",
  tags: { total_count: 15230, running: true, spindle_temp: 41.7 },
};

describe("telemetri payload'ı", () => {
  it("geçerli payload'ı kabul eder", () => {
    expect(telemetryPayloadSchema.safeParse(valid).success).toBe(true);
  });

  it.each([
    ["ofsetli zaman damgası", { ...valid, ts: "2026-10-19T11:15:30+03:00" }],
    ["sürüm uyuşmazlığı", { ...valid, v: 2 }],
    ["boş tag listesi", { ...valid, tags: {} }],
    ["NaN değer", { ...valid, tags: { a: Number.NaN } }],
    ["Infinity değer", { ...valid, tags: { a: Number.POSITIVE_INFINITY } }],
    ["metin değer", { ...valid, tags: { a: "12" } }],
    ["geçersiz tag adı", { ...valid, tags: { "Total Count": 1 } }],
    ["geçersiz makine kodu", { ...valid, machine_code: "CNC_01" }],
  ])("reddeder: %s", (_label, payload) => {
    expect(telemetryPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it("boolean değerleri 0/1'e çevirir", () => {
    expect(tagValueToNumber(true)).toBe(1);
    expect(tagValueToNumber(false)).toBe(0);
    expect(tagValueToNumber(3.5)).toBe(3.5);
  });
});

describe("status payload'ı", () => {
  it("hata mesajı opsiyoneldir", () => {
    expect(statusPayloadSchema.safeParse({ v: 1, machine_code: "cnc-01", ts: valid.ts, online: true }).success).toBe(true);
    expect(statusPayloadSchema.safeParse({ v: 1, machine_code: "cnc-01", ts: valid.ts, online: false, error: "ECONNRESET" }).success).toBe(true);
  });
});
