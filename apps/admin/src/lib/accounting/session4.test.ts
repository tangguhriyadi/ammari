import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import {
  accessoryMovements,
  auditLog,
  fiscalPeriods,
  journalEntries,
  journalLines,
  payments,
  postingIssues,
  privateFiles,
  purchases,
  supplierPayments,
  suppliers,
} from "@ammari/db/schema";
import { checkoutOrderValues, insertAccessory, insertOrder, insertStaffUser } from "@ammari/db/test-fixtures";
import { withRollback, type TestTx } from "@ammari/db/test-utils";
import { ActionError, FieldError } from "@/lib/errors";
import type { StoredPrivateFile } from "@/lib/supplier-payments/store-upload";
import { parseLedgerFilters } from "./filters";
import { MANUAL_JOURNAL_MESSAGES } from "./manual-journal-input";
import { insertStaffJournal, OPENING_MESSAGES, postManualJournal, reverseStaffJournal } from "./manual-journals";
import { buildOpeningLines, getActiveOpening, OPENING_BALANCE_MESSAGES, postOpeningBalance, proposeOpeningBalances, type OpeningProposal } from "./opening-balance";
import { PERIOD_MESSAGES } from "./period-rules";
import { closePeriod, listPeriods, reopenPeriod } from "./periods";
import { getLedger } from "./queries";
import { getTrialBalance } from "./trial-balance";

// Session 4 against the real triggers in ammari_test (docs/plans/accounting.md §5, §6, §7; D-22,
// D-23): manual journals (attachment, audit, reversal), period close/reopen, the opening balance
// wizard, Neraca saldo and the trial-month / official-books split. Every test rolls back;
// `set constraints all immediate` makes the deferred balance and reversal-mirror triggers check
// what was written before the rollback.

const IN_JANUARY = new Date("2027-01-20T05:00:00Z");
const IN_MARCH = new Date("2027-03-15T05:00:00Z");

async function checkDeferred(tx: TestTx) {
  await tx.execute(sql`set constraints all immediate`);
  await tx.execute(sql`set constraints all deferred`);
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error as Error,
  );
}

function fakeAttachment(): StoredPrivateFile {
  const id = randomUUID();
  const sha = id.replaceAll("-", "").padEnd(64, "b");
  return {
    id,
    purpose: "journal_attachment",
    storageKey: `test/journal_attachment/2027/01/${id}.jpg`,
    processed: {
      body: Buffer.from([1]),
      contentType: "image/jpeg",
      extension: "jpg",
      byteSize: 1,
      sha256: sha,
      originalFilename: "mutasi.jpg",
      originalContentType: "image/jpeg",
      originalByteSize: 1,
      originalSha256: sha,
      jpegQuality: 82,
    },
  };
}

const TOPUP = {
  entryDate: "2027-01-15",
  description: "Top-up Saldo Biteship",
  lines: [
    { accountCode: "1-1603", debit: "1.000.000", credit: "" },
    { accountCode: "1-1201", debit: "", credit: "1.000.000" },
  ],
};

async function sidesOf(tx: TestTx, entryId: string): Promise<string[]> {
  const lines = await tx.select().from(journalLines).where(eq(journalLines.entryId, entryId)).orderBy(asc(journalLines.lineNo));
  return lines.map((line) => (line.debit > 0 ? `Dr ${line.accountCode} ${line.debit}` : `Cr ${line.accountCode} ${line.credit}`));
}

async function auditActions(tx: TestTx, entityType: string, entityId: string) {
  return tx.select({ action: auditLog.action, actor: auditLog.actorStaffUserId, after: auditLog.after }).from(auditLog).where(and(eq(auditLog.entityType, entityType), eq(auditLog.entityId, entityId)));
}

async function closeDirectly(tx: TestTx, month: string, staffId: string) {
  await tx.insert(fiscalPeriods).values({ month, status: "closed", closedAt: new Date(), closedByStaffUserId: staffId });
}

describe("manual journals (plan §5)", () => {
  test("a balanced journal with an attachment: entry, lines, attachment row and audit in one write", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const file = fakeAttachment();
      const entry = await postManualJournal(TOPUP, file, staff.id, tx, IN_JANUARY);
      await checkDeferred(tx);

      expect(entry).toMatchObject({ kind: "manual", entryDate: "2027-01-15", postedByStaffUserId: staff.id, attachmentFileId: file.id, attachmentFilePurpose: "journal_attachment" });
      expect(entry.entryNo).toMatch(/^JU-202701-\d{4}$/);
      expect(await sidesOf(tx, entry.id)).toEqual(["Dr 1-1603 1000000", "Cr 1-1201 1000000"]);
      const [fileRow] = await tx.select().from(privateFiles).where(eq(privateFiles.id, file.id));
      expect(fileRow?.purpose).toBe("journal_attachment");
      expect((await auditActions(tx, "journal_entry", entry.id)).map((row) => [row.action, row.actor])).toEqual([["create_manual", staff.id]]);
    });
  });

  test("a closed month refuses a manual journal with the form's message (D-23)", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      await closeDirectly(tx, "2027-01-01", staff.id);
      const error = await rejection(postManualJournal(TOPUP, null, staff.id, tx, new Date("2027-02-05T05:00:00Z")));
      expect(error).toBeInstanceOf(FieldError);
      expect(error.message).toBe(MANUAL_JOURNAL_MESSAGES.closedMonth);
    });
  });

  test("reverse: a mirrored entry stamped on the original, audited with the reason; never twice; never a system journal", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const entry = await postManualJournal(TOPUP, null, staff.id, tx, IN_JANUARY);
      const reversal = await reverseStaffJournal(entry.id, "Salah nominal", staff.id, tx);
      await checkDeferred(tx);

      expect(reversal.entryDate).toBe("2027-01-15");
      expect(await sidesOf(tx, reversal.id)).toEqual(["Cr 1-1603 1000000", "Dr 1-1201 1000000"]);
      const [original] = await tx.select().from(journalEntries).where(eq(journalEntries.id, entry.id));
      expect(original?.reversedByEntryId).toBe(reversal.id);
      const audits = await auditActions(tx, "journal_entry", entry.id);
      expect(audits.map((row) => row.action)).toEqual(["create_manual", "reverse"]);
      expect(audits[1]!.after).toMatchObject({ reason: "Salah nominal" });

      const again = await rejection(reverseStaffJournal(entry.id, "Lagi", staff.id, tx));
      expect(again).toBeInstanceOf(ActionError);
      expect(again.message).toBe(MANUAL_JOURNAL_MESSAGES.alreadyReversed);
      expect((await rejection(reverseStaffJournal(reversal.id, "Balik pembalik", staff.id, tx))).message).toBe(MANUAL_JOURNAL_MESSAGES.notManual);
      expect((await rejection(reverseStaffJournal(entry.id, "  ", staff.id, tx))).message).toBe(MANUAL_JOURNAL_MESSAGES.reasonRequired);
    });
  });

  test("a reversal of a journal in a closed month is dated the first day of the first open month (D-23)", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const entry = await postManualJournal(TOPUP, null, staff.id, tx, IN_JANUARY);
      await closeDirectly(tx, "2027-01-01", staff.id);
      const reversal = await reverseStaffJournal(entry.id, "Ternyata top-up Februari", staff.id, tx);
      await checkDeferred(tx);
      expect(reversal.entryDate).toBe("2027-02-01");
    });
  });
});

describe("period close and reopen (plan §7, D-22, D-23)", () => {
  test("close: stamped and audited; afterwards nothing can be posted into the month", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const closed = await closePeriod("2027-01-01", null, staff.id, tx, IN_MARCH);
      expect(closed).toMatchObject({ status: "closed", closedByStaffUserId: staff.id, closeOverrideReason: null });
      expect((await auditActions(tx, "fiscal_period", "2027-01-01")).map((row) => row.action)).toEqual(["close"]);

      const error = await rejection(postManualJournal({ ...TOPUP, entryDate: "2027-01-31" }, null, staff.id, tx, IN_MARCH));
      expect(error.message).toBe(MANUAL_JOURNAL_MESSAGES.closedMonth);
      // The database refuses too, whatever the app checks (0049 period lock).
      const direct = await rejection(insertStaffJournal(tx, { kind: "manual", entryDate: "2027-01-20", description: "Langsung", lines: [{ accountCode: "1-1603", debit: 1, credit: 0 }, { accountCode: "1-1201", debit: 0, credit: 1 }], file: null, actorStaffUserId: staff.id }));
      expect(String((direct.cause as Error | undefined)?.message ?? direct.message)).toMatch(/accounting period 2027-01 is closed/);
    });
  });

  test("the trial month is never closable; a month that has not ended is not; months close in order", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      expect((await rejection(closePeriod("2026-12-01", null, staff.id, tx, IN_MARCH))).message).toBe(PERIOD_MESSAGES.trialMonth);
      expect((await rejection(closePeriod("2027-03-01", null, staff.id, tx, IN_MARCH))).message).toBe(PERIOD_MESSAGES.notEnded);
      expect((await rejection(closePeriod("2027-02-01", null, staff.id, tx, IN_MARCH))).message).toBe(PERIOD_MESSAGES.earlierOpen("Januari 2027"));
      await closePeriod("2027-01-01", null, staff.id, tx, IN_MARCH);
      await closePeriod("2027-02-01", null, staff.id, tx, IN_MARCH);
      expect((await rejection(closePeriod("2027-02-01", null, staff.id, tx, IN_MARCH))).message).toBe(PERIOD_MESSAGES.alreadyClosed);
    });
  });

  test("open posting issues block a close unless a written reason is given; trial-month issues never block", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      await tx.insert(postingIssues).values({ sourceType: "business_expense", sourceId: randomUUID(), sourceEvent: "paid", sourceDate: "2026-12-05", issueCode: "unmapped_expense_category" });
      await tx.insert(postingIssues).values({ sourceType: "business_expense", sourceId: randomUUID(), sourceEvent: "paid", sourceDate: "2027-01-10", issueCode: "unmapped_expense_category" });

      const january = (await listPeriods(tx, IN_MARCH)).find((row) => row.month === "2027-01-01");
      expect(january?.openIssueCount).toBe(1);
      const refused = await rejection(closePeriod("2027-01-01", "   ", staff.id, tx, IN_MARCH));
      expect(refused).toBeInstanceOf(FieldError);
      expect(refused.message).toBe(PERIOD_MESSAGES.overrideRequired);

      const closed = await closePeriod("2027-01-01", "Kategori baru dipetakan Februari", staff.id, tx, IN_MARCH);
      expect(closed.closeOverrideReason).toBe("Kategori baru dipetakan Februari");
      const [audit] = await auditActions(tx, "fiscal_period", "2027-01-01");
      expect(audit?.after).toMatchObject({ openIssueCount: 1 });
    });
  });

  test("reopen: only a closed month, only with a written reason, audited; the override is cleared", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      expect((await rejection(reopenPeriod("2027-01-01", "Koreksi", staff.id, tx))).message).toBe(PERIOD_MESSAGES.notClosed);
      await tx.insert(postingIssues).values({ sourceType: "business_expense", sourceId: randomUUID(), sourceEvent: "paid", sourceDate: "2027-01-10", issueCode: "unmapped_expense_category" });
      await closePeriod("2027-01-01", "Menyusul", staff.id, tx, IN_MARCH);

      const noReason = await rejection(reopenPeriod("2027-01-01", "  ", staff.id, tx, IN_MARCH));
      expect(noReason).toBeInstanceOf(FieldError);
      expect(noReason.message).toBe(PERIOD_MESSAGES.reopenReasonRequired);

      const reopened = await reopenPeriod("2027-01-01", "Biaya listrik Januari terlewat", staff.id, tx, new Date("2027-03-16T05:00:00Z"));
      expect(reopened).toMatchObject({ status: "open", reopenedReason: "Biaya listrik Januari terlewat", reopenedByStaffUserId: staff.id, closeOverrideReason: null });
      const audits = await auditActions(tx, "fiscal_period", "2027-01-01");
      expect(audits.map((row) => row.action)).toEqual(["close", "reopen"]);
      // Open again: a journal into January posts.
      await postManualJournal({ ...TOPUP, entryDate: "2027-01-31" }, null, staff.id, tx, IN_MARCH);
    });
  });

  test("months reopen newest first: January cannot reopen while February is closed (no open gap inside the closed run)", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      await closePeriod("2027-01-01", null, staff.id, tx, IN_MARCH);
      await closePeriod("2027-02-01", null, staff.id, tx, IN_MARCH);
      expect((await rejection(reopenPeriod("2027-01-01", "Koreksi Januari", staff.id, tx, IN_MARCH))).message).toBe(PERIOD_MESSAGES.laterClosed("Februari 2027"));
      await reopenPeriod("2027-02-01", "Koreksi Februari", staff.id, tx, IN_MARCH);
      await reopenPeriod("2027-01-01", "Koreksi Januari", staff.id, tx, IN_MARCH);
    });
  });

  test("a missing opening journal (D-22) and the PPh final rate end (D-20) are warnings on January, never a block", async () => {
    await withRollback(async (tx) => {
      const january = (await listPeriods(tx, IN_MARCH)).find((row) => row.month === "2027-01-01");
      expect(january?.warnings).toEqual(["Saldo awal belum dibukukan. Bukukan saldo awal sebelum menutup Januari 2027.", "Tarif PPh final berakhir, periksa pengaturan pajak."]);
      expect(january?.closeRefusal).toBeNull();
      const trial = (await listPeriods(tx, IN_MARCH)).find((row) => row.month === "2026-12-01");
      expect(trial).toMatchObject({ isTrial: true, closeRefusal: PERIOD_MESSAGES.trialMonth });
    });
  });
});

/** Answers confirming every proposal at its proposed amount. */
function confirmAll(proposals: OpeningProposal[]) {
  return proposals.map((proposal) => ({ key: proposal.key, confirmed: true, amount: String(Math.abs(proposal.amount)), proposedAmount: proposal.amount }));
}

const BANK_LINE = { accountCode: "1-1201", debit: "25.000.000", credit: "", memo: "Rekening koran 31/12" };

describe("opening balances (D-22, plan §5.4)", () => {
  test("proposals as of 31 Dec 2026: an accessory stock value and a DP paid before anything arrived (advance, by supplier)", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const before = new Map((await proposeOpeningBalances(tx)).map((proposal) => [proposal.key, proposal.amount]));

      const accessory = await insertAccessory(tx);
      await tx.insert(accessoryMovements).values({ accessoryId: accessory.id, qty: 100, valueAmount: 150_000, type: "adjustment", refType: "manual", reason: "recount" });
      const [vendor] = await tx.insert(suppliers).values({ name: `Uji Saldo Awal ${randomUUID().slice(0, 8)}` }).returning();
      const [purchase] = await tx.insert(purchases).values({ purchaseNo: `PO-SA-${randomUUID().slice(0, 8)}`, supplierId: vendor!.id, orderedAt: "2026-12-10", createdByStaffUserId: staff.id }).returning();
      const proofId = randomUUID();
      await tx.insert(privateFiles).values({
        id: proofId,
        purpose: "payment_proof",
        storageKey: `test/payment_proof/${proofId}.jpg`,
        contentType: "image/jpeg",
        byteSize: 1,
        sha256: "c".repeat(64),
        originalFilename: "bukti.jpg",
        originalContentType: "image/jpeg",
        originalByteSize: 1,
        originalSha256: "c".repeat(64),
        uploadedByStaffUserId: staff.id,
      });
      await tx.insert(supplierPayments).values({
        paymentNo: `BYR-SA-${randomUUID().slice(0, 8)}`,
        targetType: "purchase",
        purchaseId: purchase!.id,
        supplierId: vendor!.id,
        supplierName: vendor!.name,
        paidAt: "2026-12-12",
        amount: 2_000_000,
        method: "transfer",
        proofFileId: proofId,
        recordedByStaffUserId: staff.id,
      });

      const after = await proposeOpeningBalances(tx);
      const accessoryProposal = after.find((proposal) => proposal.key === "inventory.accessory");
      expect(accessoryProposal).toMatchObject({ accountCode: "1-1502" });
      expect(accessoryProposal!.amount - (before.get("inventory.accessory") ?? 0)).toBe(150_000);
      const advance = after.find((proposal) => proposal.key === `prepaid.purchase_advance:${vendor!.id}`);
      expect(advance).toMatchObject({ accountCode: "1-1601", amount: 2_000_000, supplierId: vendor!.id });
      // D-14: every system proposal is a balance-sheet account (assets 1-, liabilities 2-), never an expense.
      for (const proposal of after) expect(proposal.accountCode).toMatch(/^[12]-/);
    });
  });

  test("a paid web order not yet shipped by the cut-over is customer money held (2-1201), never revenue", async () => {
    await withRollback(async (tx) => {
      const before = (await proposeOpeningBalances(tx)).find((proposal) => proposal.key === "liability.customer_deposit")?.amount ?? 0;
      await insertOrder(tx, { ...checkoutOrderValues(), status: "to_ship", paymentStatus: "paid", paidAt: new Date("2026-12-28T03:00:00Z"), subtotalAmount: 259_000 });
      const deposit = (await proposeOpeningBalances(tx)).find((proposal) => proposal.key === "liability.customer_deposit");
      expect(deposit?.accountCode).toBe("2-1201");
      expect(deposit!.amount - before).toBe(-259_000);
    });
  });

  test("a paid web order cancelled before the cut-over owes what was not yet refunded by then (2-1202, refund dated as W4 dates it)", async () => {
    await withRollback(async (tx) => {
      const before = (await proposeOpeningBalances(tx)).find((proposal) => proposal.key === "liability.customer_refund")?.amount ?? 0;
      const order = await insertOrder(tx, {
        ...checkoutOrderValues(),
        status: "cancelled",
        paymentStatus: "partially_refunded",
        paidAt: new Date("2026-12-20T03:00:00Z"),
        cancelledAt: new Date("2026-12-21T03:00:00Z"),
        subtotalAmount: 300_000,
      });
      // The gateway's partial refund (100.000) arrived on 22 Dec: 200.000 is still owed at the cut-over.
      await tx.insert(payments).values({
        orderId: order.id,
        provider: "midtrans",
        providerOrderId: `T-${randomUUID()}`,
        attempt: 1,
        grossAmount: 300_000,
        status: "partially_refunded",
        paidAt: new Date("2026-12-20T03:00:00Z"),
        refundedAmount: 100_000,
        updatedAt: new Date("2026-12-22T03:00:00Z"),
      });
      const refund = (await proposeOpeningBalances(tx)).find((proposal) => proposal.key === "liability.customer_refund");
      expect(refund?.accountCode).toBe("2-1202");
      expect(refund!.amount - before).toBe(-200_000);
    });
  });

  test("posting: only from 1 Jan 2027; every proposal confirmed; the rest balanced into 3-9001; one active opening; audited", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const proposals = await proposeOpeningBalances(tx);
      const input = { proposals: confirmAll(proposals), lines: [BANK_LINE] };

      expect((await rejection(postOpeningBalance(input, null, staff.id, tx, new Date("2026-12-31T10:00:00Z")))).message).toBe(OPENING_BALANCE_MESSAGES.tooEarly);
      if (proposals.length > 0) {
        const unconfirmed = await rejection(postOpeningBalance({ ...input, proposals: input.proposals.map((answer, index) => (index === 0 ? { ...answer, confirmed: false } : answer)) }, null, staff.id, tx, IN_JANUARY));
        expect(unconfirmed.message).toBe(OPENING_BALANCE_MESSAGES.unconfirmed);
      }
      const stale = await rejection(postOpeningBalance({ ...input, proposals: [...input.proposals, { key: "inventory.unknown", confirmed: true, amount: "1", proposedAmount: 1 }] }, null, staff.id, tx, IN_JANUARY));
      expect(stale.message).toBe(OPENING_BALANCE_MESSAGES.proposalChanged);

      const entry = await postOpeningBalance(input, fakeAttachment(), staff.id, tx, IN_JANUARY);
      await checkDeferred(tx);
      expect(entry).toMatchObject({ kind: "opening", entryDate: "2027-01-01", description: "Saldo awal per 31 Desember 2026" });
      const sides = await sidesOf(tx, entry.id);
      expect(sides).toContain("Dr 1-1201 25000000");
      expect(sides.filter((side) => side.includes(" 3-9001 "))).toHaveLength(1);
      expect((await getActiveOpening(tx))?.id).toBe(entry.id);
      expect((await auditActions(tx, "journal_entry", entry.id)).map((row) => row.action)).toEqual(["create_opening"]);

      expect((await rejection(postOpeningBalance(input, null, staff.id, tx, IN_JANUARY))).message).toBe(OPENING_BALANCE_MESSAGES.alreadyPosted);
    });
  });

  test("a wrong opening is reversed and entered again, but never while January 2027 is closed", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const input = { proposals: confirmAll(await proposeOpeningBalances(tx)), lines: [BANK_LINE] };
      const first = await postOpeningBalance(input, null, staff.id, tx, IN_JANUARY);
      await closeDirectly(tx, "2027-01-01", staff.id);
      expect((await rejection(reverseStaffJournal(first.id, "Saldo bank salah", staff.id, tx))).message).toBe(OPENING_MESSAGES.januaryClosed);
      await tx.update(fiscalPeriods).set({ status: "open", reopenedAt: new Date(), reopenedByStaffUserId: staff.id, reopenedReason: "Koreksi saldo awal" }).where(eq(fiscalPeriods.month, "2027-01-01"));

      const reversal = await reverseStaffJournal(first.id, "Saldo bank salah", staff.id, tx);
      expect(reversal.entryDate).toBe("2027-01-01");
      const second = await postOpeningBalance({ ...input, lines: [{ ...BANK_LINE, debit: "24.500.000" }] }, null, staff.id, tx, IN_JANUARY);
      await checkDeferred(tx);
      expect((await getActiveOpening(tx))?.id).toBe(second.id);
    });
  });

  test("a proposal whose amount changed since the page was opened is refused, never silently confirmed", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const accessory = await insertAccessory(tx);
      await tx.insert(accessoryMovements).values({ accessoryId: accessory.id, qty: 10, valueAmount: 40_000, type: "adjustment", refType: "manual", reason: "recount" });
      const shown = confirmAll(await proposeOpeningBalances(tx));
      // A stock movement lands between opening the page and pressing "Bukukan".
      await tx.insert(accessoryMovements).values({ accessoryId: accessory.id, qty: 5, valueAmount: 20_000, type: "adjustment", refType: "manual", reason: "recount" });
      const error = await rejection(postOpeningBalance({ proposals: shown, lines: [BANK_LINE] }, null, staff.id, tx, IN_JANUARY));
      expect(error.message).toBe(OPENING_BALANCE_MESSAGES.proposalChanged);
    });
  });

  test("buildOpeningLines: proposal sides kept, corrected amounts used, zero lines dropped, plug to equity on the short side", () => {
    const accounts = new Map([
      ["1-1201", { isActive: true, isHeader: false }],
      ["1-1501", { isActive: true, isHeader: false }],
      ["2-1101", { isActive: true, isHeader: false }],
    ]);
    const proposals: OpeningProposal[] = [
      { key: "inventory.fabric", accountCode: "1-1501", accountName: "Persediaan bahan kain", label: "Persediaan kain", basis: "", amount: 4_000_000, supplierId: null },
      { key: "payable.material_supplier:s1", accountCode: "2-1101", accountName: "Utang", label: "Utang: Toko A", basis: "", amount: -1_500_000, supplierId: "s1" },
      { key: "inventory.defect", accountCode: "1-1506", accountName: "Cacat", label: "Cacat", basis: "", amount: 10_000, supplierId: null },
    ];
    const result = buildOpeningLines(
      proposals,
      {
        proposals: [
          { key: "inventory.fabric", confirmed: true, amount: "3.900.000", proposedAmount: 4_000_000 },
          { key: "payable.material_supplier:s1", confirmed: true, amount: "1.500.000", proposedAmount: -1_500_000 },
          { key: "inventory.defect", confirmed: true, amount: "0", proposedAmount: 10_000 },
        ],
        lines: [{ accountCode: "1-1201", debit: "600.000", credit: "" }],
      },
      accounts,
      "3-9001",
    );
    expect(result.lines.map((line) => [line.accountCode, line.debit, line.credit, line.supplierId ?? null])).toEqual([
      ["1-1501", 3_900_000, 0, null],
      ["2-1101", 0, 1_500_000, "s1"],
      ["1-1201", 600_000, 0, null],
      ["3-9001", 0, 3_000_000, null],
    ]);
    expect(result.equityPlug).toBe(-3_000_000);
  });
});

describe("the trial month and the official books (D-22, books.ts)", () => {
  test("December's journals never reach a 2027 balance; the opening journal is the official opening balance", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      const journal = (entryDate: string, kind: "manual" | "opening", lines: [string, number, number][]) =>
        insertStaffJournal(tx, { kind, entryDate, description: "Uji", lines: lines.map(([accountCode, debit, credit]) => ({ accountCode, debit, credit })), file: null, actorStaffUserId: staff.id });
      // Trial month: a Biteship top-up of 500.000 out of the bank.
      await journal("2026-12-10", "manual", [["1-1603", 500_000, 0], ["1-1201", 0, 500_000]]);
      // Official books: the opening (bank 10.000.000), then a January top-up of 1.000.000.
      await journal("2027-01-01", "opening", [["1-1201", 10_000_000, 0], ["3-9001", 0, 10_000_000]]);
      await journal("2027-01-05", "manual", [["1-1603", 1_000_000, 0], ["1-1201", 0, 1_000_000]]);
      await checkDeferred(tx);

      const january = await getTrialBalance({ from: "2027-01-01", to: "2027-01-31" }, tx);
      const bankJanuary = january.rows.find((row) => row.code === "1-1201");
      expect(bankJanuary).toMatchObject({ openingDebit: 10_000_000, credit: 1_000_000, debit: 0, closingDebit: 9_000_000 });
      expect(january.rows.find((row) => row.code === "1-1603")).toMatchObject({ openingDebit: 0, debit: 1_000_000, closingDebit: 1_000_000 });
      expect(january.balanced).toBe(true);

      const february = await getTrialBalance({ from: "2027-02-01", to: "2027-02-28" }, tx);
      expect(february.rows.find((row) => row.code === "1-1201")).toMatchObject({ openingDebit: 9_000_000, closingDebit: 9_000_000 });

      const december = await getTrialBalance({ from: "2026-12-01", to: "2026-12-31" }, tx);
      expect(december.range.segment).toBe("trial");
      expect(december.rows.find((row) => row.code === "1-1201")).toMatchObject({ openingDebit: 0, credit: 500_000, closingCredit: 500_000 });

      // A range across the cut-over is the official books from 1 Jan 2027.
      const crossing = await getTrialBalance({ from: "2026-12-15", to: "2027-01-31" }, tx);
      expect(crossing.range).toMatchObject({ from: "2027-01-01", adjusted: true });
      expect(crossing.rows.find((row) => row.code === "1-1201")).toMatchObject({ openingDebit: 10_000_000, closingDebit: 9_000_000 });

      const ledger = await getLedger(parseLedgerFilters({ account: "1-1201", from: "2027-01-01", to: "2027-01-31" }, "2027-01-20"), undefined, undefined, tx);
      expect(ledger?.openingBalance).toBe(10_000_000);
      expect(ledger?.rows.map((row) => [row.entryDate, row.credit, row.balance])).toEqual([["2027-01-05", 1_000_000, 9_000_000]]);
    });
  });

  test("closing January checks the official books only, so December's trial journals cannot unbalance it", async () => {
    await withRollback(async (tx) => {
      const staff = await insertStaffUser(tx);
      await insertStaffJournal(tx, { kind: "manual", entryDate: "2026-12-10", description: "Uji", lines: [{ accountCode: "1-1603", debit: 1, credit: 0 }, { accountCode: "1-1201", debit: 0, credit: 1 }], file: null, actorStaffUserId: staff.id });
      const closed = await closePeriod("2027-01-01", null, staff.id, tx, IN_MARCH);
      const [audit] = await auditActions(tx, "fiscal_period", "2027-01-01");
      expect(closed.status).toBe("closed");
      // The December line (1 rupiah) is not in January's totals.
      const totals = audit?.after as { debitTotal: number; creditTotal: number };
      expect(totals.debitTotal).toBe(totals.creditTotal);
      expect(totals.debitTotal % 2 === 1 ? "odd" : "even").toBe("even");
    });
  });
});
