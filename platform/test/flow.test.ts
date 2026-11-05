import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/index";
import { addDays, todayIst } from "../src/domain/gst";

let cookie = "";
async function req(method: string, path: string, body?: Record<string, string | string[]>, headers: Record<string, string> = {}) {
  let payload: URLSearchParams | undefined;
  if (body) {
    payload = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) for (const x of Array.isArray(v) ? v : [v]) payload.append(k, x);
  }
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`https://ops.test${path}`, {
    method, body: payload, redirect: "manual",
    headers: { ...(payload ? { "content-type": "application/x-www-form-urlencoded" } : {}), ...(cookie ? { cookie } : {}), ...headers },
  }), env, ctx);
  await waitOnExecutionContext(ctx);
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  return { status: res.status, location: res.headers.get("location") ?? "", text: await res.text() };
}
const sql = <T = any>(q: string, ...p: unknown[]) => env.DB.prepare(q).bind(...p).all<T>().then((r) => r.results);
const today = todayIst();

let kochi = "", bengaluru = "", batchA = "";

beforeAll(async () => {
  // First-run setup creates the admin and signs them in.
  const r = await req("POST", "/setup", { name: "Febin", email: "febin@bareskinscience.in", password: "correct horse battery" });
  expect(r.status).toBe(302);
  expect(r.location).toBe("/settings?ok=welcome");
  await req("POST", "/settings", {
    company_name: "Bare Origin Pvt Ltd", brand_name: "bare Skinscience", gstin: "", address: "Kochi, Kerala", state_code: "32", phone: "", email: "hello@bareskinscience.in",
    invoice_prefix: "BSS", bank_details: "", invoice_terms: "",
  });
  await req("POST", "/products/prd_02", { sku: "BSS-02", name: "No. 02 Barrier Serum", size: "30 ml", hsn: "3304", gst: "18", unit: "NOS", mrp: "899", price: "500", reorder: "10", active: "1" });
  await req("POST", "/customers/new", { name: "Skin Clinic Kochi", kind: "clinic", gstin: "", state_code: "32", credit_days: "30", active: "1" });
  await req("POST", "/customers/new", { name: "Derma Bengaluru", kind: "clinic", gstin: "29AAPFU0939F1ZR", state_code: "32", credit_days: "15", active: "1" });
  [kochi, bengaluru] = (await sql<{ id: string }>("SELECT id FROM customers ORDER BY name DESC")).map((c) => c.id);
  // Two batches: B (later expiry) received first, A (earlier expiry) second, so FEFO must pick A first.
  await req("POST", "/stock/receive", { product_id: "prd_02", batch_no: "B-200", qty: "20", cost: "150", mfg_date: "2026-08-01", expiry_date: "2028-08-01", date: today, ref: "GRN-1", note: "" });
  await req("POST", "/stock/receive", { product_id: "prd_02", batch_no: "A-100", qty: "5", cost: "140", mfg_date: "2026-06-01", expiry_date: "2027-12-01", date: today, ref: "GRN-2", note: "" });
  batchA = (await sql<{ id: string }>("SELECT id FROM batches WHERE batch_no = 'A-100'"))[0].id;
});

const onHand = async () => Object.fromEntries((await sql<{ batch_no: string; on_hand: number }>("SELECT batch_no, on_hand FROM batches")).map((b) => [b.batch_no, b.on_hand]));
const line = (qty: string, extra: Record<string, string> = {}) => ({ product_id: "prd_02", batch_id: "", qty, rate: "", discount: "", ...extra });
function invoiceBody(customer: string, lines: Record<string, string>[]) {
  const pick = (k: string) => lines.map((l) => l[k]);
  return { customer_id: customer, date: today, notes: "", product_id: pick("product_id"), batch_id: pick("batch_id"), qty: pick("qty"), rate: pick("rate"), discount: pick("discount") };
}

describe("bare Ops", () => {
  it("keeps everything behind sign-in, and setup closes after the first admin", async () => {
    const saved = cookie; cookie = "";
    expect((await req("GET", "/invoices")).location).toBe("/login?next=%2Finvoices");
    expect((await req("GET", "/setup")).location).toBe("/login");
    expect((await req("POST", "/login", { email: "febin@bareskinscience.in", password: "wrong password!" })).status).toBe(401);
    cookie = saved;
  });

  it("issues an intra-state invoice, earliest expiry first, splitting across batches", async () => {
    const r = await req("POST", "/invoices/new", invoiceBody(kochi, [line("7")]));
    expect(r.status).toBe(302);
    const [inv] = await sql("SELECT * FROM invoices WHERE customer_id = ?", kochi);
    expect(inv.number).toMatch(/^BSS\/\d\d-\d\d\/0001$/);
    expect(inv.interstate).toBe(0);
    expect(inv.taxable_paise).toBe(350000);          // 7 × ₹500
    expect(inv.cgst_paise).toBe(31500);              // 9%
    expect(inv.sgst_paise).toBe(31500);
    expect(inv.total_paise).toBe(413000);
    expect(inv.due_date).toBe(addDays(today, 30));
    const lines = await sql("SELECT batch_no, qty FROM invoice_lines WHERE invoice_id = ? ORDER BY line_no", inv.id);
    expect(lines).toEqual([{ batch_no: "A-100", qty: 5 }, { batch_no: "B-200", qty: 2 }]);
    expect(await onHand()).toEqual({ "A-100": 0, "B-200": 18 });
    const page = await req("GET", r.location);
    expect(page.text).toContain("Tax invoice");
    expect(page.text).toContain("Rupees Four Thousand One Hundred Thirty Only");
  });

  it("bills IGST to another state, applies discounts and numbers invoices in sequence", async () => {
    await req("POST", "/invoices/new", invoiceBody(bengaluru, [line("4", { rate: "450", discount: "10" })]));
    const [inv] = await sql("SELECT * FROM invoices WHERE customer_id = ?", bengaluru);
    expect(inv.number).toMatch(/\/0002$/);
    expect(inv.interstate).toBe(1);
    expect(inv.taxable_paise).toBe(162000);          // 4 × 450 less 10%
    expect(inv.igst_paise).toBe(29160);
    expect(inv.cgst_paise + inv.sgst_paise).toBe(0);
    expect(inv.total_paise).toBe(191200);            // 1911.60 rounded
    expect(inv.round_off_paise).toBe(40);
  });

  it("refuses to oversell, sell from an empty batch, or write anything on failure", async () => {
    const before = await onHand();
    const r = await req("POST", "/invoices/new", invoiceBody(kochi, [line("15")]));
    expect(r.status).toBe(400);
    expect(r.text).toContain("Not enough");
    const r2 = await req("POST", "/invoices/new", invoiceBody(kochi, [line("1", { batch_id: batchA })]));
    expect(r2.text).toContain("in that batch");
    expect(await onHand()).toEqual(before);
    expect((await sql("SELECT COUNT(*) AS n FROM invoices"))[0].n).toBe(2);
  });

  it("records part payments, refuses overpayment, and cancels only unpaid invoices", async () => {
    const [inv] = await sql("SELECT * FROM invoices WHERE customer_id = ?", kochi);
    await req("POST", `/invoices/${inv.id}/pay`, { amount: "1000", date: today, method: "upi", reference: "UTR1" });
    expect((await req("POST", `/invoices/${inv.id}/pay`, { amount: "5000", date: today, method: "upi", reference: "" })).text).toContain("still due");
    expect((await req("POST", `/invoices/${inv.id}/cancel`, { reason: "wrong clinic" })).text).toContain("Remove the payments");
    const [pay] = await sql("SELECT id FROM payments WHERE invoice_id = ?", inv.id);
    await req("POST", `/invoices/${inv.id}/payments/${pay.id}/delete`, {});
    expect((await req("POST", `/invoices/${inv.id}/cancel`, { reason: "wrong clinic" })).status).toBe(302);
    expect(await onHand()).toEqual({ "A-100": 5, "B-200": 16 });   // 18, less 4 to Bengaluru, plus 2 returned
    expect((await req("POST", `/invoices/${inv.id}/cancel`, { reason: "again" })).text).toContain("already cancelled");
    expect((await sql("SELECT status FROM invoices WHERE id = ?", inv.id))[0].status).toBe("cancelled");
  });

  it("keeps the ledger equal to on-hand stock and blocks negative adjustments", async () => {
    expect((await req("POST", "/stock/adjust", { batch_id: batchA, qty: "-9", reason: "damaged", note: "", date: today })).text).toContain("only 5");
    await req("POST", "/stock/adjust", { batch_id: batchA, qty: "-2", reason: "sample", note: "testers", date: today });
    const rows = await sql("SELECT b.on_hand, (SELECT SUM(qty) FROM stock_moves m WHERE m.batch_id = b.id) AS ledger FROM batches b");
    for (const r of rows) expect(r.on_hand).toBe(r.ledger);
  });

  it("produces the GST report and CSVs", async () => {
    const month = today.slice(0, 7);
    const page = await req("GET", `/reports?month=${month}`);
    expect(page.text).toContain("29AAPFU0939F1ZR");
    const hsn = await req("GET", `/reports?month=${month}&format=hsn`);
    expect(hsn.text).toContain("3304,NOS,4,18,1911.60,1620.00,291.60,0.00,0.00");
    expect((await req("GET", "/")).text).toContain("Sales this month");
  });

  it("refuses cross-site form posts and limits settings to admins", async () => {
    expect((await req("POST", "/stock/adjust", { batch_id: batchA, qty: "-1", reason: "count", note: "", date: today }, { origin: "https://evil.example" })).status).toBe(403);
    await req("POST", "/settings/users", { name: "Staff", email: "staff@bareskinscience.in", role: "staff", password: "staff password 1" });
    cookie = "";
    await req("POST", "/login", { email: "staff@bareskinscience.in", password: "staff password 1", next: "/" });
    expect((await req("GET", "/invoices")).status).toBe(200);
    expect((await req("GET", "/settings")).status).toBe(403);
  });
});
