import { describe, expect, it } from "vitest";
import { amountInWords, financialYear, gstinError, invoiceNumber, invoiceTotals, lineTax, parseRupees, todayIst } from "../src/domain/gst";

describe("GST rules", () => {
  it("financial year runs April to March", () => {
    expect(financialYear("2026-03-31")).toBe("25-26");
    expect(financialYear("2026-04-01")).toBe("26-27");
    expect(financialYear("2099-12-01")).toBe("99-00");
    expect(invoiceNumber("BSS", "26-27", 7)).toBe("BSS/26-27/0007");
    expect(invoiceNumber("BSS12", "26-27", 9999).length).toBeLessThanOrEqual(16);
  });
  it("splits intra-state GST into equal CGST and SGST, inter-state into IGST", () => {
    const l = { qty: 3, rate_paise: 33333, discount_bp: 1000, gst_rate_bp: 1800 };
    const intra = lineTax(l, false), inter = lineTax(l, true);
    expect(intra.taxable_paise).toBe(89999);   // 999.99 less 10% (100.00)
    expect(intra.cgst_paise).toBe(intra.sgst_paise);
    expect(inter.igst_paise).toBe(Math.round(intra.taxable_paise * 0.18));
  });
  it("rounds the invoice to the rupee", () => {
    const t = invoiceTotals([{ taxable_paise: 10050, cgst_paise: 905, sgst_paise: 905, igst_paise: 0 }]);
    expect(t.total_paise).toBe(11900);
    expect(t.round_off_paise).toBe(40);
  });
  it("parses rupees and writes amounts in Indian words", () => {
    expect(parseRupees("1,250.5")).toBe(125050);
    expect(parseRupees("abc")).toBeNull();
    expect(amountInWords(12345678)).toBe("Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and Seventy Eight Paise Only");
    expect(amountInWords(1_00_00_000_00)).toBe("Rupees One Crore Only");
  });
  it("checks GSTIN check digits", () => {
    expect(gstinError("27AAPFU0939F1ZV")).toBeNull();
    expect(gstinError("27AAPFU0939F1ZX")).toMatch(/check digit/);
    expect(gstinError("hello")).toMatch(/look like/);
    expect(gstinError("")).toBeNull();
  });
  it("uses India time for today", () => {
    expect(todayIst(new Date("2026-11-05T20:00:00Z"))).toBe("2026-11-06");
  });
});
