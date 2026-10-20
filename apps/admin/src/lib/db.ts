import "server-only";

// The real definitions live in @ammari/commerce (docs/plans/cart-checkout.md D1) so the order,
// stock and voucher domain code there and every admin feature share one `Tx`/`Database` type and
// one `writeAuditLog`. Re-exported here for the existing `@/lib/db` call sites.
export { defaultDb, writeAuditLog, type Database, type Tx } from "@ammari/commerce/db";
