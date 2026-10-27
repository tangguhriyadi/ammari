import { sql, type SQL } from "drizzle-orm";
import type { VoucherFilter } from "@/lib/customers/search-params";
import { EXPIRING_SOON_DAYS } from "./status";

// The SQL twin of effectiveVoucherStatus (status.ts, docs/plans/growth.md §9.1): every admin
// count, filter and list decides from these, never from the stored status alone. Like checkout,
// "usable" means stored `active` AND `expires_at > now()`. Each fragment reads the outer query's
// `vouchers` row through the alias `v`.

/** The effective status as text: 'active' | 'used' | 'expired' | 'void'. */
export function effectiveVoucherStatusSql(): SQL<string> {
  return sql<string>`(case
    when v.status in ('used', 'void') then v.status
    when v.status = 'expired' or v.expires_at <= now() then 'expired'
    else 'active'
  end)`;
}

/** Effective-active: what checkout would still redeem. */
export function voucherUsableSql(): SQL {
  return sql`(v.status = 'active' and v.expires_at > now())`;
}

/** "Segera berakhir": usable and expiring within EXPIRING_SOON_DAYS. */
export function voucherExpiringSoonSql(): SQL {
  return sql`(${voucherUsableSql()} and v.expires_at <= now() + make_interval(days => ${EXPIRING_SOON_DAYS}::int))`;
}

/** WHERE condition for a Voucher-tab filter tab. */
export function voucherFilterSql(filter: VoucherFilter): SQL {
  switch (filter) {
    case "active":
      return voucherUsableSql();
    case "expiring":
      return voucherExpiringSoonSql();
    case "used":
    case "void":
      return sql`v.status = ${filter}`;
    case "expired":
      return sql`(v.status = 'expired' or (v.status = 'active' and v.expires_at <= now()))`;
  }
}
