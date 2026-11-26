-- Custom migration (drizzle-kit generate --custom): a trigger change, no schema.ts diff.
-- docs/plans/accounting.md Session 2 (posting engine), found by its database review.
--
-- A reversal must always be able to undo what was posted. 0049's journal_lines_guard_insert
-- refused any line on an inactive account, reversals included. accounts_guard_update only stops
-- deactivating an account a mapping still points at, so the accountant can re-map a category
-- (e.g. Gaji 6-2101 -> 6-2901) and then deactivate the old account; the engine's reverse + repost
-- for every journal still on 6-2101 was then refused on each run, forever.
--
-- Now a line of a kind = 'reversal' entry may go to an inactive account (and name an inactive
-- cash account). This is safe: journal_entry_assert_balanced (deferred, 0049) requires a reversal
-- to mirror its target line for line, and the target's lines were on active accounts when posted,
-- so a reversal can never introduce a new account. A header is still refused for every entry
-- (accounts_guard_update already stops an account with lines from becoming a header). Every other
-- check of 0049 is unchanged: own transaction only, open period, FOR SHARE on the account rows.
--
-- Backward compatible with the previous release (expand only): the function is replaced in place,
-- it accepts strictly more than before, and the previous release never posts reversals.
CREATE OR REPLACE FUNCTION journal_lines_guard_insert()
RETURNS trigger AS $$
DECLARE
  entry journal_entries%ROWTYPE;
  target accounts%ROWTYPE;
  is_reversal boolean := false;
BEGIN
  SELECT * INTO entry FROM journal_entries WHERE id = NEW.entry_id;
  IF FOUND THEN
    IF entry.created_at <> now() THEN
      RAISE EXCEPTION 'journal_lines: lines are only added in the transaction that created entry %', NEW.entry_id
        USING ERRCODE = 'check_violation';
    END IF;
    PERFORM accounting_assert_period_open(entry.entry_date);
    is_reversal := entry.kind = 'reversal';
  END IF;
  SELECT * INTO target FROM accounts WHERE code = NEW.account_code FOR SHARE;
  IF FOUND AND (target.is_header OR (NOT target.is_active AND NOT is_reversal)) THEN
    RAISE EXCEPTION 'journal_lines: account % is a header or inactive and cannot be posted to', NEW.account_code
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_lines_postable_account', TABLE = 'journal_lines';
  END IF;
  IF NEW.cash_account_code IS NOT NULL THEN
    SELECT * INTO target FROM accounts WHERE code = NEW.cash_account_code FOR SHARE;
    IF FOUND AND (target.is_header OR (NOT target.is_active AND NOT is_reversal)) THEN
      RAISE EXCEPTION 'journal_lines: cash account % is a header or inactive', NEW.cash_account_code
        USING ERRCODE = 'check_violation', CONSTRAINT = 'journal_lines_postable_account', TABLE = 'journal_lines';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
