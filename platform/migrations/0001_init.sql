-- bare Ops: inventory and GST billing.
-- Money is integer paise. GST rates are basis points (18% = 1800). Dates are YYYY-MM-DD (India time).

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO settings (key, value) VALUES
  ('company_name', 'Bare Origin Pvt Ltd'),
  ('brand_name', 'bare Skinscience'),
  ('gstin', ''),
  ('address', ''),
  ('state_code', '32'),          -- Kerala
  ('phone', ''),
  ('email', 'hello@bareskinscience.in'),
  ('invoice_prefix', 'BSS'),
  ('bank_details', ''),
  ('invoice_terms', 'Goods once sold will be taken back only if damaged in transit, reported within 48 hours.');

CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('admin', 'staff')),
  pw_hash     TEXT NOT NULL,
  pw_salt     TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  failed      INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  expires_at  TEXT NOT NULL
);

CREATE TABLE products (
  id            TEXT PRIMARY KEY,
  sku           TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  size          TEXT NOT NULL DEFAULT '',           -- e.g. 100 ml
  hsn           TEXT NOT NULL DEFAULT '3304',       -- 3304: beauty / skin-care preparations
  gst_rate_bp   INTEGER NOT NULL DEFAULT 1800 CHECK (gst_rate_bp BETWEEN 0 AND 4000),  -- confirm the rate for each HSN with your CA
  unit          TEXT NOT NULL DEFAULT 'NOS',
  mrp_paise     INTEGER NOT NULL DEFAULT 0 CHECK (mrp_paise >= 0),   -- printed MRP, GST inclusive
  price_paise   INTEGER NOT NULL DEFAULT 0 CHECK (price_paise >= 0), -- default selling rate, before GST
  reorder_level INTEGER NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Stock is held per batch (cosmetics carry batch and expiry on the label).
-- on_hand can never go below zero: a sale that would oversell fails the whole write.
CREATE TABLE batches (
  id          TEXT PRIMARY KEY,
  product_id  TEXT NOT NULL REFERENCES products(id),
  batch_no    TEXT NOT NULL COLLATE NOCASE,
  mfg_date    TEXT,
  expiry_date TEXT,
  cost_paise  INTEGER NOT NULL DEFAULT 0 CHECK (cost_paise >= 0),   -- landed cost per unit
  on_hand     INTEGER NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (product_id, batch_no)
);
CREATE INDEX batches_product ON batches (product_id, expiry_date);

-- The stock ledger. SUM(qty) per batch always equals batches.on_hand.
CREATE TABLE stock_moves (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id    TEXT NOT NULL REFERENCES batches(id),
  product_id  TEXT NOT NULL REFERENCES products(id),
  qty         INTEGER NOT NULL CHECK (qty <> 0),
  kind        TEXT NOT NULL CHECK (kind IN ('receipt', 'sale', 'sale_cancel', 'adjust')),
  reason      TEXT NOT NULL DEFAULT '',     -- for adjustments: damaged, sample, expired, count, other
  ref         TEXT NOT NULL DEFAULT '',     -- supplier bill no. or invoice number
  note        TEXT NOT NULL DEFAULT '',
  date        TEXT NOT NULL,
  user_id     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX stock_moves_batch ON stock_moves (batch_id);
CREATE INDEX stock_moves_date ON stock_moves (date);

CREATE TABLE customers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'clinic' CHECK (kind IN ('clinic', 'distributor', 'retail', 'consumer')),
  gstin       TEXT NOT NULL DEFAULT '',
  state_code  TEXT NOT NULL DEFAULT '32',
  address     TEXT NOT NULL DEFAULT '',
  city        TEXT NOT NULL DEFAULT '',
  pincode     TEXT NOT NULL DEFAULT '',
  contact     TEXT NOT NULL DEFAULT '',
  phone       TEXT NOT NULL DEFAULT '',
  email       TEXT NOT NULL DEFAULT '',
  credit_days INTEGER NOT NULL DEFAULT 30,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- GST tax invoices. Numbers run per financial year (BSS/26-27/0001) and are never reused:
-- a cancelled invoice keeps its number. Customer details are copied at issue so later edits don't change old invoices.
CREATE TABLE invoices (
  id            TEXT PRIMARY KEY,
  fy            TEXT NOT NULL,          -- 26-27
  seq           INTEGER NOT NULL,
  number        TEXT NOT NULL UNIQUE,
  date          TEXT NOT NULL,
  due_date      TEXT NOT NULL,
  customer_id   TEXT NOT NULL REFERENCES customers(id),
  bill_to_json  TEXT NOT NULL,
  seller_json   TEXT NOT NULL,
  place_of_supply TEXT NOT NULL,        -- state code
  interstate    INTEGER NOT NULL,       -- 1: IGST, 0: CGST + SGST
  taxable_paise INTEGER NOT NULL,
  cgst_paise    INTEGER NOT NULL,
  sgst_paise    INTEGER NOT NULL,
  igst_paise    INTEGER NOT NULL,
  round_off_paise INTEGER NOT NULL,
  total_paise   INTEGER NOT NULL,
  paid_paise    INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'cancelled')),
  notes         TEXT NOT NULL DEFAULT '',
  cancel_reason TEXT NOT NULL DEFAULT '',
  created_by    TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (fy, seq),
  CHECK (paid_paise >= 0 AND paid_paise <= total_paise)
);
CREATE INDEX invoices_date ON invoices (date);
CREATE INDEX invoices_customer ON invoices (customer_id);

CREATE TABLE invoice_lines (
  invoice_id    TEXT NOT NULL REFERENCES invoices(id),
  line_no       INTEGER NOT NULL,
  product_id    TEXT NOT NULL REFERENCES products(id),
  batch_id      TEXT NOT NULL REFERENCES batches(id),
  description   TEXT NOT NULL,
  batch_no      TEXT NOT NULL,
  expiry_date   TEXT,
  hsn           TEXT NOT NULL,
  qty           INTEGER NOT NULL CHECK (qty > 0),
  unit          TEXT NOT NULL,
  rate_paise    INTEGER NOT NULL,       -- per unit, before discount and GST
  discount_bp   INTEGER NOT NULL DEFAULT 0,
  taxable_paise INTEGER NOT NULL,
  gst_rate_bp   INTEGER NOT NULL,
  cgst_paise    INTEGER NOT NULL,
  sgst_paise    INTEGER NOT NULL,
  igst_paise    INTEGER NOT NULL,
  PRIMARY KEY (invoice_id, line_no)
);

CREATE TABLE payments (
  id          TEXT PRIMARY KEY,
  invoice_id  TEXT NOT NULL REFERENCES invoices(id),
  date        TEXT NOT NULL,
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  method      TEXT NOT NULL CHECK (method IN ('upi', 'bank', 'cash', 'card', 'cheque', 'other')),
  reference   TEXT NOT NULL DEFAULT '',
  user_id     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX payments_invoice ON payments (invoice_id);

CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  user_id    TEXT,
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  TEXT NOT NULL,
  data_json  TEXT
);

-- The launch routine from the website. Prices are left at zero for the team to set.
INSERT INTO products (id, sku, name, hsn, gst_rate_bp) VALUES
  ('prd_01', 'BSS-01', 'No. 01 Calm Gel Cleanser', '3304', 1800),
  ('prd_02', 'BSS-02', 'No. 02 Barrier Serum', '3304', 1800),
  ('prd_03', 'BSS-03', 'No. 03 Ceramide Barrier Cream', '3304', 1800),
  ('prd_04', 'BSS-04', 'No. 04 Daily Calm Sunscreen', '3304', 1800);
