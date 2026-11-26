-- Migration 0052: Akuntansi Session 4 (docs/plans/accounting.md §5, §7, §8 Session 4): opening
-- balances, manual journals with an attachment, and period close. EXPAND-ONLY: two nullable columns
-- on journal_entries, one on fiscal_periods, a widened private_files purpose CHECK and new CHECKs/
-- an index that no existing row can violate (no opening journal exists before this session, and the
-- previous release never writes one, an attachment or a close reason). Rollback to the previous
-- release is safe: it neither reads nor writes the new columns.
--   - private_files.purpose gains 'journal_attachment' (plan §5: re-use private_files);
--   - journal_entries.attachment_file_id/_purpose: composite FK pins the purpose; only a manual or
--     opening journal carries one; one file per journal;
--   - the books have exactly one ACTIVE opening journal, dated the cut-over day 2027-01-01 (D-22);
--     correcting it is reverse + re-enter, the reversal frees the partial unique index;
--   - fiscal_periods.close_override_reason: the written reason when a month is closed with open
--     posting issues (plan §7); only on a closed month.
-- No trigger changes: 0049's close lock, reopen stamp and append-only guards already cover these
-- columns (journal_entries_guard_mutation compares every column but the reversal stamp).

ALTER TABLE "private_files" DROP CONSTRAINT "private_files_purpose_check";--> statement-breakpoint
ALTER TABLE "fiscal_periods" ADD COLUMN "close_override_reason" text;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "attachment_file_id" uuid;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "attachment_file_purpose" text;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_attachment_file_fk" FOREIGN KEY ("attachment_file_id","attachment_file_purpose") REFERENCES "public"."private_files"("id","purpose") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_one_active_opening" ON "journal_entries" USING btree ("kind") WHERE "journal_entries"."kind" = 'opening' and "journal_entries"."reversed_by_entry_id" is null;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_attachment_file_id_unique" UNIQUE("attachment_file_id");--> statement-breakpoint
ALTER TABLE "private_files" ADD CONSTRAINT "private_files_purpose_check" CHECK ("private_files"."purpose" in ('payment_proof', 'purchase_invoice', 'expense_proof', 'journal_attachment'));--> statement-breakpoint
ALTER TABLE "fiscal_periods" ADD CONSTRAINT "fiscal_periods_close_override_reason_check" CHECK ("fiscal_periods"."close_override_reason" is null
        or ("fiscal_periods"."status" = 'closed' and btrim("fiscal_periods"."close_override_reason") <> '' and char_length("fiscal_periods"."close_override_reason") <= 500));--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_opening_date_check" CHECK ("journal_entries"."kind" <> 'opening' or "journal_entries"."entry_date" = '2027-01-01');--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_attachment_check" CHECK (("journal_entries"."attachment_file_id" is null) = ("journal_entries"."attachment_file_purpose" is null)
        and ("journal_entries"."attachment_file_purpose" is null or ("journal_entries"."attachment_file_purpose" = 'journal_attachment' and "journal_entries"."kind" in ('manual', 'opening'))));
