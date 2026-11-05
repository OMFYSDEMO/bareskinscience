-- Fictional sample data for local development only. Never load into production.
UPDATE products SET price_paise = 45000, mrp_paise = 79900, size = '100 ml', reorder_level = 20 WHERE id = 'prd_01';
UPDATE products SET price_paise = 65000, mrp_paise = 109900, size = '30 ml', reorder_level = 20 WHERE id = 'prd_02';
UPDATE products SET price_paise = 60000, mrp_paise = 99900, size = '50 g', reorder_level = 20 WHERE id = 'prd_03';
UPDATE products SET price_paise = 55000, mrp_paise = 94900, size = '50 g', reorder_level = 20 WHERE id = 'prd_04';
UPDATE settings SET value = 'Sample address, Kochi, Kerala 682001' WHERE key = 'address';
INSERT INTO customers (id, name, kind, gstin, state_code, address, city, pincode, contact, phone, credit_days) VALUES
  ('cus_demo1', 'Sample Derma Clinic', 'clinic', '', '32', '12 MG Road', 'Kochi', '682016', 'Dr. Sample', '9800000001', 30),
  ('cus_demo2', 'Sample Aesthetics Bengaluru', 'clinic', '29AAPFU0939F1ZR', '29', '4 Indiranagar', 'Bengaluru', '560038', 'Dr. Example', '9800000002', 15);
INSERT INTO batches (id, product_id, batch_no, mfg_date, expiry_date, cost_paise, on_hand) VALUES
  ('bat_demo1', 'prd_01', 'CG2601', '2026-09-01', '2028-08-31', 14000, 120),
  ('bat_demo2', 'prd_02', 'BS2601', '2026-09-01', '2027-01-31', 21000, 15),
  ('bat_demo3', 'prd_02', 'BS2602', '2026-10-01', '2028-09-30', 21000, 80),
  ('bat_demo4', 'prd_03', 'CB2601', '2026-09-15', '2028-09-14', 19000, 12),
  ('bat_demo5', 'prd_04', 'DC2601', '2026-10-01', '2028-03-31', 17000, 90);
INSERT INTO stock_moves (batch_id, product_id, qty, kind, ref, date) VALUES
  ('bat_demo1', 'prd_01', 120, 'receipt', 'GRN-SAMPLE-1', '2026-10-20'),
  ('bat_demo2', 'prd_02', 15, 'receipt', 'GRN-SAMPLE-1', '2026-10-20'),
  ('bat_demo3', 'prd_02', 80, 'receipt', 'GRN-SAMPLE-2', '2026-10-28'),
  ('bat_demo4', 'prd_03', 12, 'receipt', 'GRN-SAMPLE-2', '2026-10-28'),
  ('bat_demo5', 'prd_04', 90, 'receipt', 'GRN-SAMPLE-2', '2026-10-28');
