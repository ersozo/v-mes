import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatS7Address, parseS7Address, tagDefinitionSchema, tagListSchema } from "../src/index.js";

const vectors = JSON.parse(readFileSync(new URL("../test-vectors/plc.json", import.meta.url), "utf8"));

describe("ortak test vektörleri (Python ile aynı)", () => {
  it.each(vectors.addresses.valid)("geçerli adres %s", (input: string, expected: object, canonical: string) => {
    const r = parseS7Address(input);
    expect(r).toEqual({ ok: true, value: expected });
    expect(r.ok && formatS7Address(r.value)).toBe(canonical);
  });
  it.each(vectors.addresses.invalid)("geçersiz adres %j", (input: string) => {
    expect(parseS7Address(input).ok).toBe(false);
  });
  it.each(vectors.tags.valid)("geçerli tag %j", (tag: object) => {
    expect(tagDefinitionSchema.safeParse(tag).success).toBe(true);
  });
  it.each(vectors.tags.invalid)("geçersiz tag %j", (tag: object) => {
    expect(tagDefinitionSchema.safeParse(tag).success).toBe(false);
  });
  it.each(vectors.tagLists.valid.map((l: unknown) => [l]))("geçerli liste %#", (list: unknown) => {
    expect(tagListSchema.safeParse(list).success).toBe(true);
  });
  it.each(vectors.tagLists.invalid.map((l: unknown) => [l]))("geçersiz liste %#", (list: unknown) => {
    expect(tagListSchema.safeParse(list).success).toBe(false);
  });
});
