const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usdWhole = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const int = new Intl.NumberFormat("en-US");
const TZ = "America/New_York";

export function money(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return usd.format(value);
}

export function moneyWhole(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return usdWhole.format(value);
}

export function count(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return int.format(value);
}

/** Parse "1,250.5" / "$1,250.50" into a number; null when not a clean amount. */
export function parseMoney(text: string): number | null {
  const cleaned = text.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Number(cleaned);
}

export function rate(value: number | null | undefined, kind: "APY" | "APR" = "APY"): string {
  if (value === null || value === undefined) return "—";
  return `${value.toFixed(value >= 10 ? 2 : 2)}% ${kind}`;
}

/** Dates from the API are ISO dates (yyyy-mm-dd) or timestamps. */
export function date(value: string | null | undefined): string {
  if (!value) return "—";
  const d = value.length === 10 ? new Date(`${value}T12:00:00Z`) : new Date(value);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: value.length === 10 ? "UTC" : TZ });
}

export function dateNumeric(value: string | null | undefined): string {
  if (!value) return "—";
  const d = value.length === 10 ? new Date(`${value}T12:00:00Z`) : new Date(value);
  return d.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric", timeZone: value.length === 10 ? "UTC" : TZ });
}

export function time(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ });
}

export function dateTime(value: string | null | undefined): string {
  if (!value) return "—";
  return `${date(value)}, ${time(value)}`;
}

export function relative(value: string | null | undefined): string {
  if (!value) return "—";
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  return date(value);
}

export function phone(value: string | null | undefined): string {
  if (!value) return "—";
  const d = value.replace(/\D/g, "");
  if (d.length !== 10) return value;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

export function ssnMasked(last4: string | null | undefined): string {
  return last4 ? `•••-••-${last4}` : "—";
}

export function bytes(value: number): string {
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(0)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[parts.length - 1]?.[0] ?? "")).toUpperCase();
}

export function todayIso(): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return parts; // en-CA formats as yyyy-mm-dd
}

export function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
