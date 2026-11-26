import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import { inReadCommitted } from "@ammari/accounting/ledger-write";
import { journalLinesProblems, OFFICIAL_BOOKS_START, type JournalLineDraft } from "@ammari/accounting";
import { accounts, journalEntries } from "@ammari/db/schema";
import { ActionError, FieldError } from "@/lib/errors";
import { defaultDb, writeAuditLog, type Database } from "@/lib/db";
import { todayInJakarta } from "@/lib/products/jakarta-date";
import type { StoredPrivateFile } from "@/lib/supplier-payments/store-upload";
import { MANUAL_JOURNAL_MESSAGES, MAX_LINE_AMOUNT, sideAmount, validateJournalLineRows, type ManualJournalLineInput } from "./manual-journal-input";
import { insertStaffJournal, loadPostableAccountMap, mapJournalWriteError, OPENING_MESSAGES } from "./manual-journals";

// Saldo awal (docs/plans/accounting.md §5.4, D-22, Session 4): ONE kind='opening' journal dated the
// cut-over day 2027-01-01, holding the balances as of 31 Dec 2026 (the end of 2026-12-31 Jakarta,
// i.e. before 2026-12-31T17:00:00Z).
//
// System-proposed lines (the owner checks and confirms each, and may correct its amount):
//   1-1501 / 1-1502 / 1-1504 / 1-1506  the fabric, accessory, finished-goods and defect ledgers;
//   1-1505  the cost of goods whose stock left before the cut-over for orders not shipped by then;
//   1-1503  per posted, not yet finished batch: its cost (fabric + accessories + cost lines) less
//           what was received and rejected before the cut-over;
//   2-1101 / 1-1601 / 1-1402  per purchase: value received (accepted + rejected, less returned
//           defects) less what was paid; a rest is utang, an over-payment an advance, or a claim
//           when the purchase was closed before the cut-over (D-13);
//   2-1102 / 2-1103 / 1-1601 / 1-1402  per posted batch and payee: cost lines less what was paid;
//           an over-payment is an advance, or a claim when production ended before the cut-over;
//   2-1201  paid web orders and manual orders at "to ship" not shipped by the cut-over;
//   2-1202  paid web orders cancelled before the cut-over whose refund was not recorded by then.
// Payments voided at any time are left out: the books start from what is known when the opening is
// entered (in January), and a void of a 2026 record dated in 2027 posts nothing (books.ts).
// Typed lines: Kas/Bank from bank statements, Saldo Penjual, Piutang Midtrans and Saldo Biteship from
// the dashboards, fixed assets, anything else. The difference goes to 3-9001 Ekuitas saldo awal,
// closed into Modal pemilik once approved (template "Tutup ekuitas saldo awal ke modal").
//
// Never built from December's trial journals: the official books are a separate set (books.ts).

/** The end of 31 Dec 2026, Jakarta time. */
const CUTOVER_INSTANT = `${OFFICIAL_BOOKS_START}T00:00:00+07:00`;

// Each movement counts on the date its posting rule dates it (plan §4): a goods-receipt movement on
// the receipt's own received_at (P1/P2/R2: a receipt entered on 5 Jan for goods received on 30 Dec
// belongs to 2026, one entered on 30 Dec dated 2 Jan to 2027); every other movement on created_at
// (sales, adjustments, production consumption); defects on occurred_at (the reject's received_at).
// `m` is the movement; receipt rows find their header through the receipt item.
const RECEIPT_JOIN = sql.raw(`left join goods_receipt_items rgi on m.ref_type = 'goods_receipt' and rgi.id::text = m.ref_id left join goods_receipts rg on rg.id = rgi.goods_receipt_id`);
const FG_RECEIPT_JOIN = sql.raw(`left join goods_receipt_items rgi on m.ref_type = 'goods_receipt_item' and rgi.id::text = m.ref_id left join goods_receipts rg on rg.id = rgi.goods_receipt_id`);
const BEFORE_CUTOVER = sql`(case when rg.id is not null then rg.received_at < ${OFFICIAL_BOOKS_START}::date else m.created_at < ${CUTOVER_INSTANT}::timestamptz end)`;

export const OPENING_BALANCE_MESSAGES = {
  tooEarly: "Saldo awal baru bisa dibukukan mulai 1 Januari 2027, setelah semua data 2026 lengkap.",
  alreadyPosted: "Saldo awal sudah dibukukan. Balik dulu jurnal saldo awal yang lama untuk membukukan ulang.",
  unconfirmed: "Centang setiap baris usulan setelah Ibu memeriksanya.",
  proposalChanged: "Usulan berubah sejak halaman dibuka. Muat ulang halaman lalu periksa lagi.",
  proposalAmount: "Isi jumlah dengan bilangan bulat 0 atau lebih (tanpa koma).",
  nothingToPost: "Belum ada saldo untuk dibukukan.",
} as const;

export const OPENING_DESCRIPTION = "Saldo awal per 31 Desember 2026";

export interface OpeningProposal {
  /** Stable key the form sends back with the owner's confirmation. */
  key: string;
  accountCode: string;
  accountName: string;
  label: string;
  basis: string;
  /** Signed: positive = debit, negative = credit. */
  amount: number;
  supplierId: string | null;
}

export interface OpeningTypedAccount {
  accountCode: string;
  accountName: string;
  hint: string;
}

export interface ActiveOpening {
  id: string;
  entryNo: string;
  createdAt: Date;
}

export interface OpeningBalancePage {
  proposals: OpeningProposal[];
  typedAccounts: OpeningTypedAccount[];
  activeOpening: ActiveOpening | null;
  canPost: boolean;
}

type Row = Record<string, unknown>;

async function rows<T extends Row>(db: Database, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}

const num = (value: unknown): number => Number(value ?? 0);

async function systemAccountNames(db: Database): Promise<Map<string, { code: string; name: string }>> {
  const list = await db.select({ systemKey: accounts.systemKey, code: accounts.code, name: sql<string>`${accounts.name}::text` }).from(accounts);
  return new Map(list.filter((row) => row.systemKey).map((row) => [row.systemKey as string, { code: row.code, name: row.name }]));
}

/** Every system proposal as of the cut-over (see the header). Zero amounts are left out. */
export async function proposeOpeningBalances(db: Database = defaultDb): Promise<OpeningProposal[]> {
  const system = await systemAccountNames(db);
  const account = (systemKey: string) => {
    const found = system.get(systemKey);
    if (!found) throw new Error(`chart of accounts has no system account ${systemKey}`);
    return found;
  };
  const proposals: OpeningProposal[] = [];
  const add = (key: string, systemKey: string, label: string, basis: string, amount: number, supplierId: string | null = null) => {
    if (amount === 0) return;
    const target = account(systemKey);
    proposals.push({ key, accountCode: target.code, accountName: target.name, label, basis, amount, supplierId });
  };

  const [stock] = await rows<{ fabric: string; accessory: string; finished: string; defect: string }>(
    db,
    sql`select
      (select coalesce(sum(m.value_amount), 0) from fabric_stock_movements m ${RECEIPT_JOIN} where ${BEFORE_CUTOVER})::bigint as fabric,
      (select coalesce(sum(m.value_amount), 0) from accessory_movements m ${RECEIPT_JOIN} where ${BEFORE_CUTOVER})::bigint as accessory,
      (select coalesce(sum(m.value_amount), 0) from stock_movements m ${FG_RECEIPT_JOIN} where ${BEFORE_CUTOVER})::bigint as finished,
      (select coalesce(sum(value_amount), 0) from defect_movements where occurred_at < ${OFFICIAL_BOOKS_START})::bigint as defect`,
  );
  add("inventory.fabric", "inventory.fabric", "Persediaan kain", "Nilai buku stok kain per 31 Des 2026", num(stock?.fabric));
  add("inventory.accessory", "inventory.accessory", "Persediaan aksesoris", "Nilai buku stok aksesoris per 31 Des 2026", num(stock?.accessory));
  add("inventory.finished_goods", "inventory.finished_goods", "Persediaan barang jadi", "Nilai buku stok barang jadi per 31 Des 2026", num(stock?.finished));
  add("inventory.defect", "inventory.defect", "Persediaan barang cacat", "Nilai buku barang cacat per 31 Des 2026", num(stock?.defect));

  // Goods out of stock before the cut-over for orders not handed to the courier by then. A sale
  // and its cancel-return before the cut-over net to zero.
  const [unshipped] = await rows<{ amount: string; order_count: number }>(
    db,
    sql`select coalesce(sum(net), 0)::bigint as amount, (count(*) filter (where net <> 0))::int as order_count from (
      select o.id, -sum(sm.value_amount) as net
      from stock_movements sm
      join order_items oi on oi.id::text = sm.ref_id
      join orders o on o.id = oi.order_id
      where sm.ref_type = 'order_item' and sm.type in ('sale', 'return') and sm.created_at < ${CUTOVER_INSTANT}::timestamptz
        and (o.shipped_at is null or o.shipped_at >= ${CUTOVER_INSTANT}::timestamptz)
      group by o.id
    ) per_order`,
  );
  add("inventory.sold_not_shipped", "inventory.sold_not_shipped", "Barang terjual belum dikirim", `HPP ${num(unshipped?.order_count)} pesanan yang belum dikirim per 31 Des 2026`, num(unshipped?.amount));

  // Work in progress per batch still in production at the cut-over. A batch finished ("received")
  // or short-closed before the cut-over holds nothing (its rest was settled then, D-15); legacy
  // batches stocked at posting (before receipts existed) are left out.
  const [wip] = await rows<{ amount: string; batch_count: number }>(
    db,
    sql`with open_batches as (
      select pb.id from production_batches pb
      where pb.status = 'posted' and pb.posted_at < ${CUTOVER_INSTANT}::timestamptz
        -- Ended before the cut-over exactly as R3 dates the end (batchEndDate, Session 8): received or
        -- closed (the close before the cut-over), with no receipt and no return to the tailor on or
        -- after it. A batch closed in December but still receiving in January is open at the cut-over.
        and not (pb.receipt_status in ('received', 'closed')
          and (pb.receipt_status <> 'closed' or pb.closed_at < ${CUTOVER_INSTANT}::timestamptz)
          and not exists (select 1 from goods_receipts gr where gr.production_batch_id = pb.id and gr.received_at >= ${OFFICIAL_BOOKS_START}::date)
          and not exists (select 1 from defect_movements dm join production_batch_items pbi on pbi.id = dm.production_batch_item_id
            left join defect_movements orig on orig.id = dm.reverses_movement_id
            where pbi.production_batch_id = pb.id and dm.occurred_at >= ${OFFICIAL_BOOKS_START}::date
              and (dm.type = 'return_out' or (dm.type = 'reversal' and orig.type = 'return_out'))))
        and not exists (
          select 1 from production_batch_items pbi join stock_movements sm on sm.ref_type = 'production_batch_item' and sm.ref_id = pbi.id::text
          where pbi.production_batch_id = pb.id)
    ), per_batch as (
      select b.id,
        (select coalesce(-sum(f.value_amount), 0) from fabric_stock_movements f where f.ref_type = 'production_batch' and f.ref_id = b.id::text and f.created_at < ${CUTOVER_INSTANT}::timestamptz)
        + (select coalesce(-sum(a.value_amount), 0) from accessory_movements a where a.ref_type = 'production_batch' and a.ref_id = b.id::text and a.created_at < ${CUTOVER_INSTANT}::timestamptz)
        + (select coalesce(sum(c.total), 0) from production_batch_costs c where c.production_batch_id = b.id)
        - (select coalesce(sum(sm.value_amount), 0) from stock_movements sm
             join goods_receipt_items gri on gri.id::text = sm.ref_id
             join goods_receipts gr on gr.id = gri.goods_receipt_id
             join production_batch_items pbi on pbi.id = gri.production_batch_item_id
           where sm.type = 'production' and sm.ref_type = 'goods_receipt_item' and pbi.production_batch_id = b.id and gr.received_at < ${OFFICIAL_BOOKS_START}::date)
        - (select coalesce(sum(dm.value_amount), 0) from defect_movements dm
             join production_batch_items pbi on pbi.id = dm.production_batch_item_id
             left join defect_movements orig on orig.id = dm.reverses_movement_id
           where pbi.production_batch_id = b.id and dm.occurred_at < ${OFFICIAL_BOOKS_START}::date
             and (dm.type in ('reject', 'return_out') or (dm.type = 'reversal' and orig.type in ('reject', 'return_out'))))
        as amount
      from open_batches b
    )
    select coalesce(sum(amount), 0)::bigint as amount, (count(*) filter (where amount <> 0))::int as batch_count from per_batch`,
  );
  add("inventory.wip", "inventory.wip", "Barang dalam proses", `Sisa biaya ${num(wip?.batch_count)} batch produksi yang belum selesai per 31 Des 2026`, num(wip?.amount));

  // Purchases (D-13): received (accepted + rejected, less defects returned to the supplier) less paid.
  const purchaseRows = await rows<{ supplier_id: string; supplier_name: string; purchase_no: string; closed_before: boolean; net: string }>(
    db,
    sql`with received as (
      select pi.purchase_id, sum(m.value_amount) as value from (
        select value_amount, ref_id from fabric_stock_movements where ref_type = 'goods_receipt' and type in ('purchase', 'purchase_void')
        union all
        select value_amount, ref_id from accessory_movements where ref_type = 'goods_receipt' and type in ('purchase', 'purchase_void')
      ) m
      join goods_receipt_items gri on gri.id::text = m.ref_id
      join goods_receipts gr on gr.id = gri.goods_receipt_id
      join purchase_items pi on pi.id = gri.purchase_item_id
      where gr.received_at < ${OFFICIAL_BOOKS_START}::date
      group by pi.purchase_id
    ), defects as (
      select pi.purchase_id, sum(dm.value_amount) as value
      from defect_movements dm
      join purchase_items pi on pi.id = dm.purchase_item_id
      left join defect_movements orig on orig.id = dm.reverses_movement_id
      where dm.occurred_at < ${OFFICIAL_BOOKS_START}::date
        and (dm.type in ('reject', 'return_out') or (dm.type = 'reversal' and orig.type in ('reject', 'return_out')))
      group by pi.purchase_id
    ), paid as (
      select purchase_id, sum(amount) as value from supplier_payments
      where purchase_id is not null and paid_at < ${OFFICIAL_BOOKS_START} and voided_at is null
      group by purchase_id
    )
    select p.supplier_id, s.name::text as supplier_name, p.purchase_no,
      (p.closed_at is not null and p.closed_at < ${CUTOVER_INSTANT}::timestamptz and p.status = 'closed') as closed_before,
      (coalesce(r.value, 0) + coalesce(d.value, 0) - coalesce(pd.value, 0))::bigint as net
    from purchases p
    join suppliers s on s.id = p.supplier_id
    left join received r on r.purchase_id = p.id
    left join defects d on d.purchase_id = p.id
    left join paid pd on pd.purchase_id = p.id
    where coalesce(r.value, 0) + coalesce(d.value, 0) <> coalesce(pd.value, 0)
    order by s.name, p.purchase_no`,
  );

  // Production batches: service cost lines less payments, per payee (NULL = no supplier).
  // An over-payment is an advance while the batch is still in production, a claim once production
  // ended (received or short-closed) before the cut-over: the same position rule R3 applies
  // (packages/accounting/src/rules/production.ts, Session 8).
  const batchRows = await rows<{ supplier_id: string | null; supplier_name: string | null; ended_before: boolean; net: string }>(
    db,
    sql`select x.supplier_id, s.name::text as supplier_name,
      coalesce(bool_or(pb.receipt_status in ('received', 'closed')
        and (pb.receipt_status <> 'closed' or pb.closed_at < ${CUTOVER_INSTANT}::timestamptz)
        and not exists (select 1 from goods_receipts gr where gr.production_batch_id = pb.id and gr.received_at >= ${OFFICIAL_BOOKS_START}::date)
        and not exists (select 1 from defect_movements dm join production_batch_items pbi on pbi.id = dm.production_batch_item_id
          left join defect_movements orig on orig.id = dm.reverses_movement_id
          where pbi.production_batch_id = pb.id and dm.occurred_at >= ${OFFICIAL_BOOKS_START}::date
            -- Returns to the tailor and their reversals only, as batchEndDate (R3) reads them.
            and (dm.type = 'return_out' or (dm.type = 'reversal' and orig.type = 'return_out')))), false) as ended_before,
      sum(x.value)::bigint as net from (
      select c.production_batch_id as batch_id, c.supplier_id, c.total as value
      from production_batch_costs c join production_batches pb on pb.id = c.production_batch_id
      where pb.status = 'posted' and pb.posted_at < ${CUTOVER_INSTANT}::timestamptz
      union all
      select production_batch_id, supplier_id, -amount from supplier_payments
      where production_batch_id is not null and paid_at < ${OFFICIAL_BOOKS_START} and voided_at is null
    ) x
    join production_batches pb on pb.id = x.batch_id
    left join suppliers s on s.id = x.supplier_id
    group by x.batch_id, x.supplier_id, s.name
    having sum(x.value) <> 0`,
  );

  // One line per (account, supplier): utang and advances by supplier.
  const bySupplier = new Map<string, { systemKey: string; supplierId: string | null; supplierName: string; amount: number; documents: number }>();
  const addSupplier = (systemKey: string, supplierId: string | null, supplierName: string, amount: number) => {
    const key = `${systemKey}:${supplierId ?? "none"}`;
    const current = bySupplier.get(key) ?? { systemKey, supplierId, supplierName, amount: 0, documents: 0 };
    current.amount += amount;
    current.documents += 1;
    bySupplier.set(key, current);
  };
  for (const row of purchaseRows) {
    const net = num(row.net);
    if (net > 0) addSupplier("payable.material_supplier", row.supplier_id, row.supplier_name, -net);
    else addSupplier(row.closed_before ? "receivable.supplier_claim" : "prepaid.purchase_advance", row.supplier_id, row.supplier_name, -net);
  }
  for (const row of batchRows) {
    const net = num(row.net);
    const name = row.supplier_name ?? "Tanpa pemasok";
    if (net > 0) addSupplier(row.supplier_id ? "payable.production_service" : "payable.no_supplier", row.supplier_id, name, -net);
    else addSupplier(row.ended_before ? "receivable.supplier_claim" : "prepaid.purchase_advance", row.supplier_id, name, -net);
  }
  const supplierLabels: Record<string, string> = {
    "payable.material_supplier": "Utang pemasok bahan",
    "payable.production_service": "Utang jasa produksi",
    "payable.no_supplier": "Utang jasa produksi tanpa pemasok",
    "prepaid.purchase_advance": "Uang muka pembelian",
    "receivable.supplier_claim": "Piutang klaim pemasok",
  };
  for (const [key, entry] of [...bySupplier.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    add(key, entry.systemKey, `${supplierLabels[entry.systemKey]}: ${entry.supplierName}`, `${entry.documents} dokumen, diterima dikurangi dibayar per 31 Des 2026`, entry.amount, entry.supplierId);
  }

  // Customer money held at the cut-over (D-1: revenue at handover to the courier).
  const [deposits] = await rows<{ checkout: string; checkout_count: number; manual: string; manual_count: number; refund: string; refund_count: number }>(
    db,
    sql`with held as (
      select o.id, o.total_amount, o.payment_status is not null as is_checkout,
        o.cancelled_at is not null and o.cancelled_at < ${CUTOVER_INSTANT}::timestamptz as cancelled_before,
        -- Refunded before the cut-over, dated as W4 dates it: a staff-recorded refund by its
        -- record_refund audit entry, a gateway refund/chargeback by the payment's updated_at; the
        -- amount is refunded_amount (a partial refund leaves the rest owed).
        (select coalesce(sum(p.refunded_amount), 0) from payments p
          where p.order_id = o.id and p.refunded_amount > 0 and (
            (p.status = 'refunded' and exists (
              select 1 from audit_log a where a.entity_type = 'order' and a.entity_id = o.id::text and a.action = 'record_refund' and a.created_at < ${CUTOVER_INSTANT}::timestamptz))
            or (p.status in ('partially_refunded', 'chargeback') and p.updated_at < ${CUTOVER_INSTANT}::timestamptz)))::bigint as refunded_before
      from orders o
      where (o.shipped_at is null or o.shipped_at >= ${CUTOVER_INSTANT}::timestamptz)
        and (
          (o.payment_status is not null and o.paid_at < ${CUTOVER_INSTANT}::timestamptz)
          or (o.payment_status is null and o.channel_id not in ('shopee', 'tiktok') and exists (
            select 1 from order_items oi join stock_movements sm on sm.ref_type = 'order_item' and sm.ref_id = oi.id::text
            where oi.order_id = o.id and sm.type = 'sale' and sm.created_at < ${CUTOVER_INSTANT}::timestamptz))
        )
    )
    select
      coalesce(sum(total_amount) filter (where is_checkout and not cancelled_before), 0)::bigint as checkout,
      (count(*) filter (where is_checkout and not cancelled_before))::int as checkout_count,
      coalesce(sum(total_amount) filter (where not is_checkout and not cancelled_before), 0)::bigint as manual,
      (count(*) filter (where not is_checkout and not cancelled_before))::int as manual_count,
      coalesce(sum(greatest(total_amount - refunded_before, 0)) filter (where is_checkout and cancelled_before), 0)::bigint as refund,
      (count(*) filter (where is_checkout and cancelled_before and total_amount > refunded_before))::int as refund_count
    from held`,
  );
  add(
    "liability.customer_deposit",
    "liability.customer_deposit",
    "Uang muka pelanggan",
    `${num(deposits?.checkout_count)} pesanan website sudah dibayar dan ${num(deposits?.manual_count)} pesanan manual siap kirim, belum dikirim per 31 Des 2026`,
    -(num(deposits?.checkout) + num(deposits?.manual)),
  );
  add(
    "liability.customer_refund",
    "liability.customer_refund",
    "Utang pengembalian dana pelanggan",
    `${num(deposits?.refund_count)} pesanan website dibatalkan setelah dibayar, refund belum dicatat per 31 Des 2026`,
    -num(deposits?.refund),
  );
  return proposals;
}

const TYPED_ACCOUNTS: readonly { systemKey: string; hint: string }[] = [
  { systemKey: "cash.on_hand", hint: "Hitung uang tunai per 31 Des 2026." },
  { systemKey: "bank.main", hint: "Saldo rekening koran per 31 Des 2026." },
  { systemKey: "seller_balance.shopee", hint: "Saldo Penjual di Shopee Seller Centre per 31 Des 2026." },
  { systemKey: "seller_balance.tiktok", hint: "Saldo Penjual di TikTok Seller Center per 31 Des 2026." },
  { systemKey: "receivable.midtrans", hint: "Dana Midtrans yang belum dicairkan per 31 Des 2026." },
  { systemKey: "prepaid.biteship", hint: "Saldo di dashboard Biteship per 31 Des 2026." },
];

export async function getActiveOpening(db: Database = defaultDb): Promise<ActiveOpening | null> {
  const [row] = await db
    .select({ id: journalEntries.id, entryNo: journalEntries.entryNo, createdAt: journalEntries.createdAt })
    .from(journalEntries)
    .where(and(eq(journalEntries.kind, "opening"), isNull(journalEntries.reversedByEntryId)))
    .limit(1);
  return row ?? null;
}

export async function getOpeningBalancePage(db: Database = defaultDb, now: Date = new Date()): Promise<OpeningBalancePage> {
  const [proposals, system, activeOpening] = await Promise.all([proposeOpeningBalances(db), systemAccountNames(db), getActiveOpening(db)]);
  const typedAccounts = TYPED_ACCOUNTS.flatMap(({ systemKey, hint }) => {
    const found = system.get(systemKey);
    return found ? [{ accountCode: found.code, accountName: found.name, hint }] : [];
  });
  return { proposals, typedAccounts, activeOpening, canPost: todayInJakarta(now) >= OFFICIAL_BOOKS_START && activeOpening === null };
}

export interface OpeningBalanceInput {
  /** One per system proposal: the owner's tick, the amount (as typed, without sign), and the signed
   * amount the page proposed, so a change in the data since then is caught, not silently confirmed. */
  proposals: { key: string; confirmed: boolean; amount: string; proposedAmount: number }[];
  /** Typed lines: Kas/Bank, platform balances, fixed assets... */
  lines: ManualJournalLineInput[];
}

export interface OpeningBalanceResult {
  lines: JournalLineDraft[];
  /** Signed plug on 3-9001 (positive = debit). */
  equityPlug: number;
}

/** Builds the opening journal's lines from the confirmed proposals and the typed lines, plus the
 * plug to 3-9001 Ekuitas saldo awal. Pure. Throws FieldError on any problem. */
export function buildOpeningLines(
  proposals: readonly OpeningProposal[],
  input: OpeningBalanceInput,
  accounts: ReadonlyMap<string, { isActive: boolean; isHeader: boolean }>,
  equityAccountCode: string,
): OpeningBalanceResult {
  const answers = new Map(input.proposals.map((answer) => [answer.key, answer]));
  const lines: JournalLineDraft[] = [];
  // The form must answer exactly the proposals computed now, at the amounts the page showed: a new,
  // vanished or re-valued one means the data changed since the page was opened (the proposals are
  // several statements; recomputing inside the write and comparing makes a mid-read change visible).
  if (answers.size !== proposals.length || proposals.some((proposal) => answers.get(proposal.key)?.proposedAmount !== proposal.amount)) {
    throw new FieldError("proposals", OPENING_BALANCE_MESSAGES.proposalChanged);
  }
  for (const proposal of proposals) {
    const answer = answers.get(proposal.key)!;
    if (!answer.confirmed) throw new FieldError(`proposals.${proposal.key}`, OPENING_BALANCE_MESSAGES.unconfirmed);
    const amount = sideAmount(answer.amount);
    if (amount === null || amount > MAX_LINE_AMOUNT) throw new FieldError(`proposals.${proposal.key}`, OPENING_BALANCE_MESSAGES.proposalAmount);
    if (amount === 0) continue;
    const isDebit = proposal.amount > 0;
    lines.push({ accountCode: proposal.accountCode, debit: isDebit ? amount : 0, credit: isDebit ? 0 : amount, memo: proposal.label, supplierId: proposal.supplierId });
  }
  lines.push(...validateJournalLineRows(input.lines, accounts));
  const debitTotal = lines.reduce((total, line) => total + line.debit, 0);
  const creditTotal = lines.reduce((total, line) => total + line.credit, 0);
  const equityPlug = creditTotal - debitTotal;
  if (equityPlug !== 0) {
    lines.push({
      accountCode: equityAccountCode,
      debit: equityPlug > 0 ? equityPlug : 0,
      credit: equityPlug < 0 ? -equityPlug : 0,
      memo: "Selisih saldo awal",
    });
  }
  if (lines.length < 2) throw new FieldError("lines", OPENING_BALANCE_MESSAGES.nothingToPost);
  if (journalLinesProblems(lines).length > 0) throw new FieldError("lines", MANUAL_JOURNAL_MESSAGES.amount);
  return { lines, equityPlug };
}

/** Every rule as the data is now, before the attachment is stored (so a refused form leaves no
 * object behind); postOpeningBalance checks all of it again inside its transaction. */
export async function prevalidateOpeningBalance(input: OpeningBalanceInput, db: Database = defaultDb, now: Date = new Date()): Promise<void> {
  if (todayInJakarta(now) < OFFICIAL_BOOKS_START) throw new ActionError(OPENING_BALANCE_MESSAGES.tooEarly);
  if (await getActiveOpening(db)) throw new ActionError(OPENING_BALANCE_MESSAGES.alreadyPosted);
  const [proposals, accountMap, equityCode] = await Promise.all([proposeOpeningBalances(db), loadPostableAccountMap(db), equityOpeningAccount(db)]);
  buildOpeningLines(proposals, input, accountMap, equityCode);
}

async function equityOpeningAccount(tx: Database): Promise<string> {
  const [row] = await tx.select({ code: accounts.code }).from(accounts).where(eq(accounts.systemKey, "equity.opening_balance"));
  if (!row) throw new Error("chart of accounts has no equity.opening_balance account");
  return row.code;
}

/** "Bukukan saldo awal". Only from the cut-over day, only while no active opening exists (the
 * partial unique index journal_entries_one_active_opening is the backstop), and only into an open
 * January (the period-lock trigger). The proposals are recomputed inside the transaction. */
export async function postOpeningBalance(
  input: OpeningBalanceInput,
  file: StoredPrivateFile | null,
  actorStaffUserId: string,
  db: Database = defaultDb,
  now: Date = new Date(),
) {
  if (todayInJakarta(now) < OFFICIAL_BOOKS_START) throw new ActionError(OPENING_BALANCE_MESSAGES.tooEarly);
  try {
    return await inReadCommitted(db, async (tx) => {
      // Serialises two concurrent "Bukukan" clicks before either computes anything.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('ammari.opening_balance'))`);
      if (await getActiveOpening(tx)) throw new ActionError(OPENING_BALANCE_MESSAGES.alreadyPosted);
      const [proposals, accountMap, equityCode] = await Promise.all([proposeOpeningBalances(tx), loadPostableAccountMap(tx), equityOpeningAccount(tx)]);
      const { lines, equityPlug } = buildOpeningLines(proposals, input, accountMap, equityCode);
      const { entry, fileRow } = await insertStaffJournal(tx, { kind: "opening", entryDate: OFFICIAL_BOOKS_START, description: OPENING_DESCRIPTION, lines, file, actorStaffUserId });
      await writeAuditLog(tx, {
        actorStaffUserId,
        action: "create_opening",
        entityType: "journal_entry",
        entityId: entry.id,
        after: {
          entry,
          proposals: proposals.map((proposal) => ({ ...proposal, confirmedAmount: input.proposals.find((answer) => answer.key === proposal.key)?.amount ?? null })),
          lines,
          equityPlug,
          file: fileRow,
        },
      });
      return entry;
    });
  } catch (error) {
    if (error instanceof ActionError || error instanceof FieldError) throw error;
    mapJournalWriteError(error, { message: OPENING_MESSAGES.januaryClosed });
  }
}
