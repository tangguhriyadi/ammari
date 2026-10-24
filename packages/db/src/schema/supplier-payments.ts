import { sql } from "drizzle-orm";
import { bigint, check, date, foreignKey, index, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { purchases, productionBatches, suppliers } from "./catalog";
import { checkIn, createdAtOnly } from "./columns";
import {
  PRIVATE_FILE_CONTENT_TYPES,
  PRIVATE_FILE_PURPOSES,
  PURCHASE_ATTACHMENT_KINDS,
  SUPPLIER_PAYMENT_METHODS,
  SUPPLIER_PAYMENT_TARGET_TYPES,
  type PrivateFileContentType,
  type PrivateFilePurpose,
  type PurchaseAttachmentKind,
  type SupplierPaymentMethod,
  type SupplierPaymentTargetType,
} from "./constants";
import { staffUsers } from "./rbac";

// ---------- Supplier payments with mandatory proof — migration 0038 ----------
// docs/plans/purchase-payments.md §4, session S1. All three tables are append-only, enforced by
// hand-authored triggers in 0038: private_files can never change or be deleted, and a payment or
// attachment can only gain its void stamp, once. Payment status (Belum bayar / DP / Lunas) is
// never stored; it is derived from the amount due and the non-voided payments
// (apps/admin/src/lib/supplier-payments/status.ts).

// One stored private object (a payment proof or a supplier's nota). Lives in the PRIVATE bucket,
// never the public media buckets (§5), and is only ever served through the admin's permission-
// checked route. No updated_at: rows are immutable (prevent_private_file_mutation).
export const privateFiles = pgTable(
  "private_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    purpose: text("purpose").$type<PrivateFilePurpose>().notNull(),
    storageKey: text("storage_key").notNull().unique(),
    // What is stored (photos are re-encoded to JPEG, PDFs kept as-is), never the client's claim.
    contentType: text("content_type").$type<PrivateFileContentType>().notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256").notNull(),
    // As uploaded, for display and the download name. original_sha256 backs the "this proof was
    // already used for another payment" warning (§8).
    originalFilename: text("original_filename").notNull(),
    originalContentType: text("original_content_type").notNull(),
    originalByteSize: integer("original_byte_size").notNull(),
    originalSha256: text("original_sha256").notNull(),
    uploadedByStaffUserId: uuid("uploaded_by_staff_user_id")
      .notNull()
      .references(() => staffUsers.id, { onDelete: "restrict" }),
    ...createdAtOnly(),
  },
  (table) => [
    index("private_files_uploaded_by_staff_user_id_idx").on(table.uploadedByStaffUserId),
    index("private_files_original_sha256_idx").on(table.originalSha256),
    // Composite-FK target: each referencing table pins the purpose it accepts.
    unique("private_files_id_purpose_key").on(table.id, table.purpose),
    check("private_files_purpose_check", checkIn(table.purpose, PRIVATE_FILE_PURPOSES)),
    check("private_files_content_type_check", checkIn(table.contentType, PRIVATE_FILE_CONTENT_TYPES)),
    check("private_files_storage_key_check", sql`btrim(${table.storageKey}) <> ''`),
    check("private_files_byte_size_check", sql`${table.byteSize} > 0`),
    check("private_files_original_byte_size_check", sql`${table.originalByteSize} > 0`),
    check("private_files_sha256_check", sql`${table.sha256} ~ '^[0-9a-f]{64}$'`),
    check("private_files_original_sha256_check", sql`${table.originalSha256} ~ '^[0-9a-f]{64}$'`),
    check(
      "private_files_original_filename_check",
      sql`btrim(${table.originalFilename}) <> '' and char_length(${table.originalFilename}) <= 255`,
    ),
  ],
);

// One payment to a supplier against a purchase document or a posted production batch (§4.2).
// Many per document (DP, then pelunasan). Never edited, never deleted: a wrong payment is voided
// with a required reason, stays in the history, and stops counting toward "paid" (P6). The cap
// "never above the remaining balance" is enforced in app code under the parent document's row
// lock (§4.6), not here: the amount due spans several tables.
export const supplierPayments = pgTable(
  "supplier_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // BYR-YYYYMM-NNN, generated under a per-month advisory lock (lib/documents/document-number.ts);
    // the unique constraint is the backstop.
    paymentNo: text("payment_no").notNull().unique(),
    targetType: text("target_type").$type<SupplierPaymentTargetType>().notNull(),
    // No single-column FK: superseded by supplier_payments_purchase_supplier_fk below, which also
    // pins the payee to the purchase's own supplier.
    purchaseId: uuid("purchase_id"),
    productionBatchId: uuid("production_batch_id").references(() => productionBatches.id, { onDelete: "restrict" }),
    // The payee. Always the purchase's supplier for a purchase (composite FK). For a batch, one of
    // the suppliers on its service lines (app-checked), or NULL for the lines nobody attributed.
    supplierId: uuid("supplier_id").references(() => suppliers.id, { onDelete: "restrict" }),
    // Snapshot of suppliers.name when recorded; a later rename never rewrites a payment.
    supplierName: text("supplier_name"),
    // The Asia/Jakarta calendar day the money moved. Never in the future (app-checked, A9).
    paidAt: date("paid_at", { mode: "string" }).notNull(),
    amount: bigint("amount", { mode: "number" }).notNull(),
    method: text("method").$type<SupplierPaymentMethod>().notNull(),
    note: text("note"),
    // Required (P2). Unique: one proof file belongs to exactly one payment.
    proofFileId: uuid("proof_file_id").notNull().unique(),
    // Constant, existing only so the composite FK below guarantees the proof file was stored as a
    // payment proof (same denormalize + composite FK technique as production_batch_items.fabric_id).
    proofFilePurpose: text("proof_file_purpose").$type<PrivateFilePurpose>().notNull().default("payment_proof"),
    recordedByStaffUserId: uuid("recorded_by_staff_user_id")
      .notNull()
      .references(() => staffUsers.id, { onDelete: "restrict" }),
    voidedAt: timestamp("voided_at", { withTimezone: true, mode: "date" }),
    voidedByStaffUserId: uuid("voided_by_staff_user_id").references(() => staffUsers.id, { onDelete: "restrict" }),
    voidReason: text("void_reason"),
    // = recorded_at.
    ...createdAtOnly(),
  },
  (table) => [
    index("supplier_payments_purchase_id_created_at_idx").on(table.purchaseId, table.createdAt),
    index("supplier_payments_production_batch_id_created_at_idx").on(table.productionBatchId, table.createdAt),
    index("supplier_payments_supplier_id_idx").on(table.supplierId),
    index("supplier_payments_paid_at_idx").on(table.paidAt.desc()),
    index("supplier_payments_recorded_by_staff_user_id_idx").on(table.recordedByStaffUserId),
    index("supplier_payments_voided_by_staff_user_id_idx").on(table.voidedByStaffUserId),
    foreignKey({
      columns: [table.purchaseId, table.supplierId],
      foreignColumns: [purchases.id, purchases.supplierId],
      name: "supplier_payments_purchase_supplier_fk",
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    foreignKey({
      columns: [table.proofFileId, table.proofFilePurpose],
      foreignColumns: [privateFiles.id, privateFiles.purpose],
      name: "supplier_payments_proof_file_fk",
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check("supplier_payments_target_type_check", checkIn(table.targetType, SUPPLIER_PAYMENT_TARGET_TYPES)),
    // Exactly one target, agreeing with target_type (same idiom as goods_receipts).
    check(
      "supplier_payments_exactly_one_target_check",
      sql`(${table.purchaseId} is null) <> (${table.productionBatchId} is null) and (${table.targetType} = 'purchase') = (${table.purchaseId} is not null)`,
    ),
    // A purchase payment always names its payee; the composite FK then pins it to the purchase's
    // supplier (MATCH SIMPLE would skip the check if supplier_id were NULL).
    check("supplier_payments_purchase_payee_check", sql`${table.targetType} <> 'purchase' or ${table.supplierId} is not null`),
    check(
      "supplier_payments_supplier_pair_check",
      sql`(${table.supplierId} is null) = (${table.supplierName} is null)`,
    ),
    check("supplier_payments_amount_check", sql`${table.amount} > 0`),
    check("supplier_payments_method_check", checkIn(table.method, SUPPLIER_PAYMENT_METHODS)),
    check("supplier_payments_proof_file_purpose_check", sql`${table.proofFilePurpose} = 'payment_proof'`),
    // All three void columns or none, and a reason is never blank (purchases_reopened_triple_check idiom).
    check(
      "supplier_payments_voided_triple_check",
      sql`num_nonnulls(${table.voidedAt}, ${table.voidedByStaffUserId}, ${table.voidReason}) in (0, 3) and (${table.voidReason} is null or btrim(${table.voidReason}) <> '')`,
    ),
  ],
);

// A file attached to a purchase document (§4.3): the supplier's invoice/nota, optional, many per
// purchase. Same append-only + void rule as supplier_payments.
export const purchaseAttachments = pgTable(
  "purchase_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    purchaseId: uuid("purchase_id")
      .notNull()
      .references(() => purchases.id, { onDelete: "restrict" }),
    kind: text("kind").$type<PurchaseAttachmentKind>().notNull(),
    fileId: uuid("file_id").notNull().unique(),
    // Constant; see supplier_payments.proof_file_purpose.
    filePurpose: text("file_purpose").$type<PrivateFilePurpose>().notNull().default("purchase_invoice"),
    note: text("note"),
    createdByStaffUserId: uuid("created_by_staff_user_id")
      .notNull()
      .references(() => staffUsers.id, { onDelete: "restrict" }),
    voidedAt: timestamp("voided_at", { withTimezone: true, mode: "date" }),
    voidedByStaffUserId: uuid("voided_by_staff_user_id").references(() => staffUsers.id, { onDelete: "restrict" }),
    voidReason: text("void_reason"),
    ...createdAtOnly(),
  },
  (table) => [
    index("purchase_attachments_purchase_id_created_at_idx").on(table.purchaseId, table.createdAt),
    index("purchase_attachments_created_by_staff_user_id_idx").on(table.createdByStaffUserId),
    index("purchase_attachments_voided_by_staff_user_id_idx").on(table.voidedByStaffUserId),
    foreignKey({
      columns: [table.fileId, table.filePurpose],
      foreignColumns: [privateFiles.id, privateFiles.purpose],
      name: "purchase_attachments_file_fk",
    })
      .onDelete("restrict")
      .onUpdate("restrict"),
    check("purchase_attachments_kind_check", checkIn(table.kind, PURCHASE_ATTACHMENT_KINDS)),
    check("purchase_attachments_file_purpose_check", sql`${table.filePurpose} = 'purchase_invoice'`),
    check(
      "purchase_attachments_voided_triple_check",
      sql`num_nonnulls(${table.voidedAt}, ${table.voidedByStaffUserId}, ${table.voidReason}) in (0, 3) and (${table.voidReason} is null or btrim(${table.voidReason}) <> '')`,
    ),
  ],
);
