# bare Ops: inventory and billing

Inventory and GST billing for **bare Skinscience** (Bare Origin Pvt Ltd, Kerala). One Cloudflare Worker and one D1 database, in the same Cloudflare account as the website. The website (the Pages project in `bareskinscience-upload.zip`) is not changed.

## What it does

| Area | What works |
|------|------------|
| **Products** | SKU, pack size, HSN, GST rate, unit (UQC), MRP, default selling rate (before GST), reorder level. The four launch products from the website are pre-loaded with prices at zero. |
| **Stock** | Held per **batch** with mfg and expiry dates and cost. Goods-in against a supplier bill/GRN number. Adjustments with a reason (count correction, damaged, samples & testers, expired, internal use). A full movement ledger with CSV download. Stock can never go negative: the database refuses. |
| **Customers** | Clinics, distributors, retailers, consumers. GSTIN check-digit validation; the place of supply is taken from the GSTIN. Credit period sets the due date. |
| **Invoices** | GST tax invoices numbered `BSS/26-27/0001`, restarting every April. CGST + SGST inside Kerala, IGST outside. Per-line rate and discount. Batches picked **earliest expiry first** (or a chosen batch); expired stock is never sold. HSN tax summary, amount in words, round-off to the rupee, bank details and terms. Print / save as PDF from the browser (A4). Customer and company details are frozen on each invoice. |
| **Payments** | Part or full payments (UPI, bank, cash, card, cheque) with a reference. Due, part-paid and overdue status. Receivables per customer. |
| **Cancelling** | An unpaid invoice can be cancelled with a reason: the goods go back to their batches and the number stays used. Nothing is ever deleted. |
| **Reports** | Monthly GSTR-1 shaped figures: B2B invoice-wise, B2C by state and rate, HSN summary, document range. Each downloads as CSV for your CA. Invoice list CSV by month. |
| **Users** | Email + password sign-in (PBKDF2, 14-day sessions, lockout after five wrong tries). **Admin**: everything, plus settings, users and removing payments. **Staff**: invoices, stock, customers, products. Every change is written to `audit_log`. |

### Not built yet

- Credit notes and sales returns of delivered goods (cancel only covers unpaid invoices).
- e-Invoicing (IRN/QR) and e-way bills. e-Invoicing is only required above ₹5 crore turnover.
- Purchase orders and supplier accounts; landed cost is entered by hand.
- Emailing invoices; online payment links (Razorpay, as in Aestheva, would fit here).
- Selling on the website itself (the site is clinic-led, so this starts with B2B billing).

**Check with your CA before going live:** the HSN code and GST rate for each product (defaults are HSN 3304 at 18%), and the invoice terms.

## Run it locally

```bash
cd platform
```

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:8787 and create the first admin; the app creates its tables on first start. For fictional sample clinics and stock (never in production), run this once after that:

```bash
npm run db:seed:local
```

```bash
npm test
```

```bash
npm run typecheck
```

## Deploy to Cloudflare (from GitHub)

Use the same Cloudflare account as the website's Pages project (`bareskinscience.pages.dev`), with the `bareskinscience.in` zone in it. bare Ops is served at **https://ops.bareskinscience.in**. The website's `_worker.js` refuses every `platform/` path, so this code is never served from the main site.

1. **Workers & Pages → Create → Import a repository**, pick `omfysdemo/bareskinscience`.
2. Settings on that screen:
   - Project name: `bare-ops`
   - **Root directory: `platform`**
   - Build command: leave empty. Deploy command: `npx wrangler deploy`
   - Production branch: the branch holding this code (`main` once merged)
3. Deploy. The first deploy created the `bare-ops` D1 database; its id is now pinned in `wrangler.jsonc`. The app creates its own tables on the first visit (`src/migrate.ts`); there is no migration command to run.
4. **bare-ops → Settings → Variables and Secrets → Add**: type *Secret*, name `SETUP_KEY`, value any long random text.
5. **bare-ops → Domains → Add Domain** → `ops.bareskinscience.in`. Cloudflare adds the DNS record and certificate (the `bareskinscience.in` zone is in this account). Deploys don't touch the domain once it's attached.
6. Open `https://ops.bareskinscience.in/setup`, enter the setup key (the `SETUP_KEY` value) and create the first admin. The setup page closes once a user exists. Then fill in **Settings**: GSTIN, registered address, bank details.

Every push to the production branch redeploys. A new file in `migrations/` must also be added to the list in `src/migrate.ts`.

Optional: put **Cloudflare Access** (Zero Trust → Access → Applications) in front of the hostname so only your team's emails can reach the sign-in page.

Backups: D1 keeps point-in-time recovery (7 days on the Workers Free plan, 30 on Paid) under the database's *Time Travel* tab. For an extra copy, export the database from its dashboard page.

## Code map

| Path | What it is |
|------|------------|
| `src/domain/gst.ts` | GST maths, financial year, invoice numbers, GSTIN check digit, amount in words. Pure functions. |
| `src/services/inventory.ts` | Batches, goods-in, adjustments, the ledger. |
| `src/services/invoices.ts` | Issuing (FEFO allocation, one transaction), payments, cancelling. |
| `src/services/auth.ts` | Passwords, sessions. |
| `src/pages/*.ts` | Server-rendered pages (Hono). No build step; `public/app.js` only adds small conveniences. |
| `migrations/` | D1 schema, applied by the app itself (`src/migrate.ts`). Money is integer paise, GST rates basis points. |
| `test/` | Unit tests for the GST rules and an end-to-end flow against an isolated D1. |
