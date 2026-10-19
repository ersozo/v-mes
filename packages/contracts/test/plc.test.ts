import { describe, expect, it } from "vitest";
import {
  checkRequiredRoles,
  findOverlappingTags,
  formatS7Address,
  machinePlcConfigSchema,
  parseS7Address,
  tagDefinitionSchema,
  tagListSchema,
  type TagDefinition,
} from "../src/index.js";

describe("S7 adres çözümleme", () => {
  it.each([
    ["DB1,DINT0", { db: 1, type: "DINT", offset: 0 }],
    ["db1,di4", { db: 1, type: "DINT", offset: 4 }],
    ["DB10,X8.3", { db: 10, type: "X", offset: 8, bit: 3 }],
    ["DB1,R12", { db: 1, type: "REAL", offset: 12 }],
    ["DB2,W10", { db: 2, type: "WORD", offset: 10 }],
    [" DB1,BYTE7 ", { db: 1, type: "BYTE", offset: 7 }],
  ])("%s", (input, expected) => {
    expect(parseS7Address(input)).toEqual({ ok: true, value: expected });
  });

  it.each(["DB0,INT0", "DB1,X8", "DB1,X8.8", "DB1,INT2.1", "DB1,STRING0", "M10.0", "DB1;INT0", "DB1,LREAL0", ""])(
    "reddeder: %s",
    (input) => {
      expect(parseS7Address(input).ok).toBe(false);
    },
  );

  it("kanonik biçime çevirir", () => {
    const r = parseS7Address("db3,dw20");
    expect(r.ok && formatS7Address(r.value)).toBe("DB3,DWORD20");
    const b = parseS7Address("DB1,X0.7");
    expect(b.ok && formatS7Address(b.value)).toBe("DB1,X0.7");
  });
});

describe("tag tanımları", () => {
  it("rol-tip uyumunu kontrol eder", () => {
    expect(tagDefinitionSchema.safeParse({ name: "total_count", address: "DB1,DINT0", role: "total_count" }).success).toBe(true);
    // İşaretli 16-bit sayaç taşmada negatife düşer → kabul edilmez
    expect(tagDefinitionSchema.safeParse({ name: "total_count", address: "DB1,INT0", role: "total_count" }).success).toBe(false);
    expect(tagDefinitionSchema.safeParse({ name: "running", address: "DB1,REAL8", role: "running" }).success).toBe(false);
    expect(tagDefinitionSchema.safeParse({ name: "temp", address: "DB1,REAL8", role: "process", unit: "°C" }).success).toBe(true);
  });

  it("tekrarlanan isim ve tekil rolleri reddeder, process rolü tekrarlanabilir", () => {
    const dupName = tagListSchema.safeParse([
      { name: "a", address: "DB1,DINT0", role: "total_count" },
      { name: "a", address: "DB1,REAL4", role: "process" },
    ]);
    expect(dupName.success).toBe(false);

    const dupRole = tagListSchema.safeParse([
      { name: "a", address: "DB1,DINT0", role: "total_count" },
      { name: "b", address: "DB1,DINT4", role: "total_count" },
    ]);
    expect(dupRole.success).toBe(false);

    const processes = tagListSchema.safeParse([
      { name: "a", address: "DB1,REAL0", role: "process" },
      { name: "b", address: "DB1,REAL4", role: "process" },
    ]);
    expect(processes.success).toBe(true);
  });

  it("makine ayarlarına göre zorunlu rolleri bildirir", () => {
    const tags: TagDefinition[] = [{ name: "total_count", address: "DB1,DINT0", role: "total_count" }];
    expect(checkRequiredRoles(tags, { stateSource: "counter", scrapSource: "manual" })).toEqual([]);
    expect(checkRequiredRoles(tags, { stateSource: "tag", scrapSource: "manual" })).toHaveLength(1);
    expect(checkRequiredRoles(tags, { stateSource: "tag", scrapSource: "plc" })).toHaveLength(2);
    expect(checkRequiredRoles([], { stateSource: "counter", scrapSource: "manual" })).toHaveLength(1);
  });

  it("çakışan adresleri bulur", () => {
    const tags: TagDefinition[] = [
      { name: "count", address: "DB1,DINT0", role: "total_count" },
      { name: "low_word", address: "DB1,WORD2", role: "process" },
      { name: "run", address: "DB1,X8.0", role: "running" },
      { name: "alarm", address: "DB1,X8.1", role: "process" },
      { name: "other_db", address: "DB2,DINT0", role: "process" },
    ];
    expect(findOverlappingTags(tags)).toEqual([["count", "low_word"]]);
  });
});

describe("makine PLC konfigürasyonu", () => {
  it("varsayılanları uygular (S7-1200/1500: rack 0, slot 1, port 102)", () => {
    const r = machinePlcConfigSchema.parse({
      host: "192.168.10.21",
      tags: [{ name: "total_count", address: "DB1,DINT0", role: "total_count" }],
    });
    expect(r).toMatchObject({ protocol: "s7", port: 102, rack: 0, slot: 1, poll_ms: 1000 });
  });

  it("geçersiz host ve aralık dışı poll süresini reddeder", () => {
    const tags = [{ name: "total_count", address: "DB1,DINT0", role: "total_count" }];
    expect(machinePlcConfigSchema.safeParse({ host: "bad host", tags }).success).toBe(false);
    expect(machinePlcConfigSchema.safeParse({ host: "plc-1", poll_ms: 50, tags }).success).toBe(false);
  });
});
