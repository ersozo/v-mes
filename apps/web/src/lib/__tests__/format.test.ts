import { describe, expect, it } from "vitest";
import { duration, isoToLocalInput, localInputToIso, pct, setPlantTimezone } from "../format";

describe("biçimlendirme", () => {
  it("yüzde ve süre", () => {
    expect(pct(0.8534)).toBe("%85,3");
    expect(pct(null)).toBe("—");
    expect(duration(45)).toBe("45 sn");
    expect(duration(3 * 3600 + 20 * 60)).toBe("3 sa 20 dk");
    expect(duration(2 * 86400 + 4 * 3600)).toBe("2 g 4 sa");
  });

  it("fabrika saatiyle datetime-local dönüşümü (tarayıcı saat diliminden bağımsız)", () => {
    setPlantTimezone("Europe/Istanbul");
    expect(localInputToIso("2026-10-19T08:00")).toBe("2026-10-19T05:00:00.000Z");
    expect(isoToLocalInput("2026-10-19T05:00:00Z")).toBe("2026-10-19T08:00");
  });

  it("yaz saati olan bölgede dönüşüm doğru ofseti kullanır", () => {
    setPlantTimezone("Europe/Berlin");
    expect(localInputToIso("2026-07-01T08:00")).toBe("2026-07-01T06:00:00.000Z"); // CEST +2
    expect(localInputToIso("2026-12-01T08:00")).toBe("2026-12-01T07:00:00.000Z"); // CET +1
    expect(isoToLocalInput("2026-10-25T01:30:00Z")).toBe("2026-10-25T02:30");
    setPlantTimezone("Europe/Istanbul");
  });
});
