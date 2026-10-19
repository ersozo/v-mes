// Türkçe biçimlendirme. Zamanlar fabrika saat diliminde gösterilir.

let plantTz = "Europe/Istanbul";
export function setPlantTimezone(tz: string): void {
  plantTz = tz;
}
export function getPlantTimezone(): string {
  return plantTz;
}

const nf0 = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 1 });
const compact = new Intl.NumberFormat("tr-TR", { notation: "compact", maximumFractionDigits: 1 });

export function num(v: number | null | undefined, digits: 0 | 1 = 0): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return (digits ? nf1 : nf0).format(v);
}

export function numCompact(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return Math.abs(v) >= 10_000 ? compact.format(v) : nf0.format(v);
}

/** 0–1 oranı yüzde olarak (%85,3) */
export function pct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return `%${(v * 100).toLocaleString("tr-TR", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** Süre: 45 sn, 12 dk, 3 sa 20 dk, 2 g 4 sa */
export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "—";
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} sn`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} dk`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} sa ${m % 60} dk` : `${h} sa`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} g ${h % 24} sa` : `${d} g`;
}

/** Canlı sayaç için ss:dd:sn */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

function fmt(opts: Intl.DateTimeFormatOptions) {
  return (iso: string | null | undefined) =>
    iso ? new Intl.DateTimeFormat("tr-TR", { timeZone: plantTz, ...opts }).format(new Date(iso)) : "—";
}

export const time = fmt({ hour: "2-digit", minute: "2-digit" });
export const timeSec = fmt({ hour: "2-digit", minute: "2-digit", second: "2-digit" });
export const date = fmt({ day: "2-digit", month: "2-digit", year: "numeric" });
export const dateTime = fmt({ day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export function since(iso: string | null | undefined, now = Date.now()): number {
  return iso ? (now - new Date(iso).getTime()) / 1000 : 0;
}

/** Fabrika yerel saatinde bir tarih/saatı UTC ISO'ya çevirir (datetime-local girişleri için). */
export function localInputToIso(value: string): string {
  // value: "2026-10-19T08:00" (fabrika saati). Ofseti hedef saat diliminden hesapla.
  const asUtc = new Date(value + ":00Z");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: plantTz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(asUtc);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const shown = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return new Date(asUtc.getTime() - (shown - asUtc.getTime())).toISOString();
}

export function isoToLocalInput(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: plantTz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}
