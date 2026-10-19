// PLC bağlantı ve tag tanımları (v1: Siemens S7, yalnızca DB adresleri).
//
// Adres sözdizimi node-red-contrib-s7 ile uyumludur:
//   DB<no>,<TİP><bayt>[.<bit>]     ör. DB1,DINT0   DB1,X8.0   DB1,REAL12
// S7-1200/1500'de okunan DB'lerde "Optimized block access" KAPALI olmalıdır.

import { z } from "zod";

export const TAG_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** Desteklenen veri tipleri. Uzun ve kısa yazımlar aynı tipe eşlenir. */
const TYPE_ALIASES = {
  X: "X",
  B: "BYTE",
  BYTE: "BYTE",
  I: "INT",
  INT: "INT",
  W: "WORD",
  WORD: "WORD",
  DI: "DINT",
  DINT: "DINT",
  DW: "DWORD",
  DWORD: "DWORD",
  R: "REAL",
  REAL: "REAL",
} as const;

export type S7DataType = (typeof TYPE_ALIASES)[keyof typeof TYPE_ALIASES];

const TYPE_SIZE: Record<S7DataType, number> = {
  X: 1,
  BYTE: 1,
  INT: 2,
  WORD: 2,
  DINT: 4,
  DWORD: 4,
  REAL: 4,
};

export interface S7Address {
  db: number;
  type: S7DataType;
  /** Bayt ofseti */
  offset: number;
  /** Yalnızca X tipinde (0–7) */
  bit?: number;
}

const ADDRESS_RE = /^DB(\d{1,5}),([A-Z]+)(\d{1,5})(?:\.(\d))?$/;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseS7Address(input: string): ParseResult<S7Address> {
  const m = ADDRESS_RE.exec(input.trim().toUpperCase());
  if (!m) {
    return { ok: false, error: `"${input}" geçerli bir S7 DB adresi değil (ör. DB1,DINT0 veya DB1,X8.0)` };
  }
  const [, dbStr, typeStr, offsetStr, bitStr] = m as unknown as [string, string, string, string, string | undefined];
  const type = (TYPE_ALIASES as Record<string, S7DataType>)[typeStr];
  if (!type) {
    return { ok: false, error: `Desteklenmeyen tip "${typeStr}". Desteklenenler: X, BYTE, INT, WORD, DINT, DWORD, REAL` };
  }
  const db = Number(dbStr);
  const offset = Number(offsetStr);
  if (db < 1 || db > 65535) return { ok: false, error: "DB numarası 1–65535 arasında olmalı" };
  if (offset > 65535) return { ok: false, error: "Bayt ofseti 0–65535 arasında olmalı" };

  if (type === "X") {
    if (bitStr === undefined) return { ok: false, error: "X (bit) tipi için bit numarası gerekli (ör. DB1,X8.0)" };
    const bit = Number(bitStr);
    if (bit > 7) return { ok: false, error: "Bit numarası 0–7 arasında olmalı" };
    return { ok: true, value: { db, type, offset, bit } };
  }
  if (bitStr !== undefined) return { ok: false, error: `${type} tipinde bit numarası kullanılamaz` };
  return { ok: true, value: { db, type, offset } };
}

/** Adresi kanonik (uzun) biçime çevirir: "db1,di4" → "DB1,DINT4". */
export function formatS7Address(a: S7Address): string {
  return a.type === "X" ? `DB${a.db},X${a.offset}.${a.bit}` : `DB${a.db},${a.type}${a.offset}`;
}

/** Adresin kapladığı bayt aralığı [başlangıç, bitiş) — çakışma kontrolü için. */
export function addressByteRange(a: S7Address): [number, number] {
  return [a.offset, a.offset + TYPE_SIZE[a.type]];
}

// ---------------------------------------------------------------------------
// Tag tanımları
// ---------------------------------------------------------------------------

export const TAG_ROLES = ["total_count", "scrap_count", "running", "state_code", "process"] as const;
export type TagRole = (typeof TAG_ROLES)[number];

/** Bir makinede en fazla bir kez kullanılabilen roller. */
const SINGLE_ROLES: ReadonlySet<TagRole> = new Set(["total_count", "scrap_count", "running", "state_code"]);

/**
 * Rol ↔ tip uyumluluğu.
 * Sayaçlar için INT/BYTE kabul edilmez: işaretli/küçük sayaçlar sık taşar ve taşma
 * negatif değere düştüğünde sıfırlanmadan ayırt edilemez.
 */
const ROLE_TYPES: Record<TagRole, ReadonlySet<S7DataType>> = {
  total_count: new Set(["DINT", "DWORD", "WORD"]),
  scrap_count: new Set(["DINT", "DWORD", "WORD"]),
  running: new Set(["X", "BYTE", "INT", "WORD", "DINT"]),
  state_code: new Set(["BYTE", "INT", "WORD", "DINT", "DWORD"]),
  process: new Set(["X", "BYTE", "INT", "WORD", "DINT", "DWORD", "REAL"]),
};

export const tagDefinitionSchema = z
  .object({
    name: z.string().regex(TAG_NAME_PATTERN, "tag adı küçük harfle başlamalı; yalnızca a-z, 0-9 ve _ (en fazla 64)"),
    address: z.string().min(1),
    role: z.enum(TAG_ROLES),
    unit: z.string().max(16).optional(),
  })
  .superRefine((tag, ctx) => {
    const parsed = parseS7Address(tag.address);
    if (!parsed.ok) {
      ctx.addIssue({ code: "custom", path: ["address"], message: parsed.error });
      return;
    }
    const allowed = ROLE_TYPES[tag.role];
    if (!allowed.has(parsed.value.type)) {
      ctx.addIssue({
        code: "custom",
        path: ["address"],
        message: `"${tag.role}" rolü için ${parsed.value.type} tipi uygun değil. Uygun tipler: ${[...allowed].join(", ")}`,
      });
    }
  });
export type TagDefinition = z.infer<typeof tagDefinitionSchema>;

export const tagListSchema = z
  .array(tagDefinitionSchema)
  .min(1, "en az bir tag tanımlanmalı")
  .max(256, "en fazla 256 tag")
  .superRefine((tags, ctx) => {
    const names = new Map<string, number>();
    const roles = new Map<TagRole, number>();
    tags.forEach((tag, i) => {
      if (names.has(tag.name)) {
        ctx.addIssue({ code: "custom", path: [i, "name"], message: `"${tag.name}" adı birden fazla kez kullanılmış` });
      }
      names.set(tag.name, i);
      if (SINGLE_ROLES.has(tag.role)) {
        if (roles.has(tag.role)) {
          ctx.addIssue({ code: "custom", path: [i, "role"], message: `"${tag.role}" rolü bir makinede yalnızca bir kez kullanılabilir` });
        }
        roles.set(tag.role, i);
      }
    });
  });

export const STATE_SOURCES = ["tag", "counter"] as const;
export const SCRAP_SOURCES = ["plc", "manual"] as const;
export type StateSource = (typeof STATE_SOURCES)[number];
export type ScrapSource = (typeof SCRAP_SOURCES)[number];

export interface MachineTagRequirements {
  stateSource: StateSource;
  scrapSource: ScrapSource;
}

/** Makinenin durum/hurda kaynağı seçimine göre zorunlu rollerin varlığını kontrol eder. */
export function checkRequiredRoles(tags: readonly TagDefinition[], req: MachineTagRequirements): string[] {
  const roles = new Set(tags.map((t) => t.role));
  const errors: string[] = [];
  if (!roles.has("total_count")) {
    errors.push('"total_count" rolünde bir tag zorunludur');
  }
  if (req.stateSource === "tag" && !roles.has("running") && !roles.has("state_code")) {
    errors.push('Durum kaynağı "tag" seçildiğinde "running" veya "state_code" rolünde bir tag gerekir');
  }
  if (req.scrapSource === "plc" && !roles.has("scrap_count")) {
    errors.push('Hurda kaynağı "plc" seçildiğinde "scrap_count" rolünde bir tag gerekir');
  }
  return errors;
}

/** Aynı DB içinde bayt aralıkları çakışan tag çiftleri (uyarı amaçlı; bitler aynı baytı paylaşabilir). */
export function findOverlappingTags(tags: readonly TagDefinition[]): Array<[string, string]> {
  const parsed = tags.flatMap((t) => {
    const r = parseS7Address(t.address);
    return r.ok ? [{ name: t.name, a: r.value }] : [];
  });
  const overlaps: Array<[string, string]> = [];
  for (let i = 0; i < parsed.length; i++) {
    for (let j = i + 1; j < parsed.length; j++) {
      const x = parsed[i]!;
      const y = parsed[j]!;
      if (x.a.db !== y.a.db) continue;
      if (x.a.type === "X" && y.a.type === "X") {
        if (x.a.offset === y.a.offset && x.a.bit === y.a.bit) overlaps.push([x.name, y.name]);
        continue;
      }
      const [xs, xe] = addressByteRange(x.a);
      const [ys, ye] = addressByteRange(y.a);
      if (xs < ye && ys < xe) overlaps.push([x.name, y.name]);
    }
  }
  return overlaps;
}

// ---------------------------------------------------------------------------
// Bağlantı ayarları
// ---------------------------------------------------------------------------

const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

export const plcConnectionSchema = z.object({
  protocol: z.literal("s7").default("s7"),
  host: z.string().regex(HOSTNAME_RE, "geçerli bir IP adresi veya host adı girin"),
  port: z.number().int().min(1).max(65535).default(102),
  /** S7-1200/1500: rack 0, slot 1 (S7-300: slot 2) */
  rack: z.number().int().min(0).max(7).default(0),
  slot: z.number().int().min(0).max(31).default(1),
  poll_ms: z.number().int().min(100).max(60000).default(1000),
});
export type PlcConnection = z.infer<typeof plcConnectionSchema>;

export const machinePlcConfigSchema = plcConnectionSchema.extend({
  tags: tagListSchema,
});
export type MachinePlcConfig = z.infer<typeof machinePlcConfigSchema>;
