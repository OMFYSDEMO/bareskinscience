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
npm run db:migrate:local
```

```bash
npm run db:seed:local
```

```bash
npm run dev
```

Open http://localhost:8787 and create the first admin. The seed adds fictional clinics and stock for trying things out; never load it into production.

```bash
npm test
```

```bash
npm run typecheck
```

## Deploy to Cloudflare

1. Create the database (Asia-Pacific), and paste the printed `database_id` into both places in `wrangler.jsonc`:

   ```bash
   npx wrangler d1 create bare-ops --location apac
   ```

2. Apply the schema:

   ```bash
   npm run db:migrate:remote
   ```

3. Set a one-time setup key (any long random text):

   ```bash
   npx wrangler secret put SETUP_KEY
   ```

4. Deploy:

   ```bash
   npm run deploy
   ```

5. Open `https://bare-ops.<your-subdomain>.workers.dev/setup?key=<SETUP_KEY>` and create the first admin. The setup page closes for good once a user exists. Then fill in **Settings**: GSTIN, registered address, bank details.

6. Give it a proper address. The website's zone is already in this Cloudflare account, so uncomment the `routes` line in `wrangler.jsonc` (for example `ops.bareskinscience.in`), set `"workers_dev": false`, and deploy again. Cloudflare creates the DNS record and certificate.

Optional: put **Cloudflare Access** (Zero Trust → Access → Applications) in front of the hostname so only your team's emails can even reach the sign-in page.

Alternatively, connect the GitHub repo in Workers & Pages → Create → Import a repository, with root directory `platform`. Each push then deploys.

Backups: D1 keeps point-in-time recovery (7 days on the Workers Free plan, 30 on Paid) (`npx wrangler d1 time-travel`). For an extra copy, `npx wrangler d1 export bare-ops --remote --output backup.sql`.

## Code map

| Path | What it is |
|------|------------|
| `src/domain/gst.ts` | GST maths, financial year, invoice numbers, GSTIN check digit, amount in words. Pure functions. |
| `src/services/inventory.ts` | Batches, goods-in, adjustments, the ledger. |
| `src/services/invoices.ts` | Issuing (FEFO allocation, one transaction), payments, cancelling. |
| `src/services/auth.ts` | Passwords, sessions. |
| `src/pages/*.ts` | Server-rendered pages (Hono). No build step; `public/app.js` only adds small conveniences. |
| `migrations/` | D1 schema. Money is integer paise, GST rates basis points. |
| `test/` | Unit tests for the GST rules and an end-to-end flow against an isolated D1. |
