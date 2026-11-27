-- Akuntansi (docs/plans/accounting.md §3, §6; owner + accountant decision 27 Nov 2026): Piutang
-- Midtrans, Saldo Penjual Shopee/TikTok and Saldo marketplace belum dipilah are receivables, not cash.
-- Cash for Arus kas is Kas tunai and the bank accounts only, so a marketplace or Midtrans sale becomes
-- cash in when the money reaches Kas/Bank (withdrawal / payout), classified as operating.
--
-- 0049 seeded these four rows with cash_flow_group = 'cash' and is already deployed, so it is not
-- edited: this changes the rows in place, and only while a row still holds the seeded value, so an
-- accountant's own later edit is never overwritten. Re-running is a no-op. Data only, no schema
-- change: the previous release reads the column the same way (backward compatible).
UPDATE "accounts" SET "cash_flow_group" = 'operating'
WHERE "code" IN ('1-1301', '1-1302', '1-1303', '1-1305') AND "cash_flow_group" = 'cash';
