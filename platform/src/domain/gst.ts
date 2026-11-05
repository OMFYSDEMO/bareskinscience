// Pure GST, money and date rules. No database access here, so it's all unit-tested directly.

/** ₹1,500.00 from integer paise, Indian digit grouping. */
export function inr(paise: number, symbol = true): string {
  const s = (paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return symbol ? "₹" + s : s;
}

/** "1,234.50" or "1234.5" typed by a person → paise. Returns null if it isn't a non-negative amount. */
export function parseRupees(input: string | undefined | null): number | null {
  const s = String(input ?? "").replace(/[₹,\s]/g, "");
  if (s === "") return null;
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return null;
  const [r, p = ""] = s.split(".");
  return Number(r) * 100 + Number((p + "00").slice(0, 2));
}

/** "18" or "18%" or "2.5" → basis points. */
export function parsePercentBp(input: string | undefined | null): number | null {
  const s = String(input ?? "").replace(/[%\s]/g, "");
  if (s === "") return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}
export const pct = (bp: number) => (bp / 100).toString().replace(/\.0+$/, "") + "%";

/** Today in India (YYYY-MM-DD). */
export function todayIst(now = new Date()): string {
  return new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}
export function addDays(date: string, n: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export const isDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + "T00:00:00Z"));
/** 05 Nov 2026 */
export function fmtDate(s: string | null | undefined): string {
  if (!s) return "";
  const d = new Date(s.slice(0, 10) + "T00:00:00Z");
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

/** Indian financial year (April–March) of a date, as "26-27". */
export function financialYear(date: string): string {
  const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7));
  const start = m >= 4 ? y : y - 1;
  return `${String(start % 100).padStart(2, "0")}-${String((start + 1) % 100).padStart(2, "0")}`;
}
/** BSS/26-27/0001: at most 16 characters, as GST rules require. */
export function invoiceNumber(prefix: string, fy: string, seq: number): string {
  return `${prefix}/${fy}/${String(seq).padStart(4, "0")}`;
}

export const STATES: Record<string, string> = {
  "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh", "05": "Uttarakhand",
  "06": "Haryana", "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim",
  "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur", "15": "Mizoram", "16": "Tripura", "17": "Meghalaya",
  "18": "Assam", "19": "West Bengal", "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh",
  "24": "Gujarat", "26": "Dadra and Nagar Haveli and Daman and Diu", "27": "Maharashtra", "29": "Karnataka", "30": "Goa",
  "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry", "35": "Andaman and Nicobar Islands",
  "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh", "97": "Other Territory",
};
export const stateName = (code: string) => STATES[code] ? `${STATES[code]} (${code})` : code;

/** GSTIN shape and check digit. Returns an error message, or null if it's valid. Blank is allowed (unregistered). */
export function gstinError(gstin: string): string | null {
  if (!gstin) return null;
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin)) return "GSTIN should look like 32ABCDE1234F1Z5.";
  if (!STATES[gstin.slice(0, 2)]) return "GSTIN starts with an unknown state code.";
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const p = chars.indexOf(gstin[i]) * (i % 2 ? 2 : 1);
    sum += Math.floor(p / 36) + (p % 36);
  }
  const check = chars[(36 - (sum % 36)) % 36];
  return check === gstin[14] ? null : "GSTIN check digit doesn't match. Please re-check it.";
}

export interface LineInput { qty: number; rate_paise: number; discount_bp: number; gst_rate_bp: number }
export interface LineTax { taxable_paise: number; cgst_paise: number; sgst_paise: number; igst_paise: number }

/**
 * Tax on one line. Intra-state supplies split GST equally into CGST and SGST (each rounded to the paisa,
 * so the two halves always match); inter-state supplies carry IGST.
 */
export function lineTax(l: LineInput, interstate: boolean): LineTax {
  const gross = l.qty * l.rate_paise;
  const taxable = gross - Math.round((gross * l.discount_bp) / 10000);
  if (interstate) return { taxable_paise: taxable, cgst_paise: 0, sgst_paise: 0, igst_paise: Math.round((taxable * l.gst_rate_bp) / 10000) };
  const half = Math.round((taxable * l.gst_rate_bp) / 20000);
  return { taxable_paise: taxable, cgst_paise: half, sgst_paise: half, igst_paise: 0 };
}

export interface Totals { taxable_paise: number; cgst_paise: number; sgst_paise: number; igst_paise: number; round_off_paise: number; total_paise: number }
/** Invoice totals, rounded to the nearest rupee with the difference shown as round-off. */
export function invoiceTotals(lines: LineTax[]): Totals {
  const t = lines.reduce((a, l) => ({
    taxable_paise: a.taxable_paise + l.taxable_paise, cgst_paise: a.cgst_paise + l.cgst_paise,
    sgst_paise: a.sgst_paise + l.sgst_paise, igst_paise: a.igst_paise + l.igst_paise,
  }), { taxable_paise: 0, cgst_paise: 0, sgst_paise: 0, igst_paise: 0 });
  const exact = t.taxable_paise + t.cgst_paise + t.sgst_paise + t.igst_paise;
  const total = Math.round(exact / 100) * 100;
  return { ...t, round_off_paise: total - exact, total_paise: total };
}

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen",
  "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
function below1000(n: number): string {
  const h = Math.floor(n / 100), r = n % 100;
  const rest = r < 20 ? ONES[r] : TENS[Math.floor(r / 10)] + (r % 10 ? " " + ONES[r % 10] : "");
  return [h ? ONES[h] + " Hundred" : "", rest].filter(Boolean).join(" ");
}
function words(n: number): string {
  if (n === 0) return "Zero";
  const parts: string[] = [];
  const crore = Math.floor(n / 1e7); n %= 1e7;
  const lakh = Math.floor(n / 1e5); n %= 1e5;
  const thousand = Math.floor(n / 1000); n %= 1000;
  if (crore) parts.push(words(crore) + " Crore");
  if (lakh) parts.push(below1000(lakh) + " Lakh");
  if (thousand) parts.push(below1000(thousand) + " Thousand");
  if (n) parts.push(below1000(n));
  return parts.join(" ");
}
/** "Rupees One Lakh Twenty Thousand and Fifty Paise Only" */
export function amountInWords(paise: number): string {
  const r = Math.floor(Math.abs(paise) / 100), p = Math.abs(paise) % 100;
  return `Rupees ${words(r)}${p ? ` and ${words(p)} Paise` : ""} Only`;
}
