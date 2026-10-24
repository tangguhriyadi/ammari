import { sql, type SQL } from "drizzle-orm";
import { defectMovements, goodsReceiptItems, purchaseItems, purchases } from "@ammari/db/schema";
import { qualifiedColumn } from "@ammari/db/sql-helpers";

/** One purchase line's share of §3.1's tagihan (docs/plans/purchase-payments.md), in SQL, for the
 * /purchases list and the supplier balances. It mirrors purchaseTagihan (./status.ts): the order
 * total, except a closed document (A1) is due cumulativeValue(total, ordered, settled) per line
 * (round half up, integer hundredths), and a cancelled one nothing. settled = net accepted + the
 * defect ledger's disposal-less rows (getLineQuantities). Every column is table-qualified, so it
 * is only valid where the `purchase_items` row and its `purchases` row are both in scope (a join,
 * or a correlated subquery over `purchase_items` inside a query over `purchases`).
 * purchase-payments.test.ts asserts the list's figure equals purchaseTagihan. */
export function purchaseLineTagihanSql(): SQL {
  const lineId = qualifiedColumn(purchaseItems, purchaseItems.id);
  const settled = sql`(
    coalesce((select sum(${qualifiedColumn(goodsReceiptItems, goodsReceiptItems.qtyAccepted)}) from ${goodsReceiptItems}
      where ${qualifiedColumn(goodsReceiptItems, goodsReceiptItems.purchaseItemId)} = ${lineId}), 0)
    + coalesce((select sum(${qualifiedColumn(defectMovements, defectMovements.qty)}) from ${defectMovements}
      where ${qualifiedColumn(defectMovements, defectMovements.purchaseItemId)} = ${lineId}
        and ${qualifiedColumn(defectMovements, defectMovements.disposalType)} is null), 0)
  )`;
  const total = qualifiedColumn(purchaseItems, purchaseItems.totalAmount);
  const orderedCenti = sql`round(${qualifiedColumn(purchaseItems, purchaseItems.qtyOrdered)} * 100)`;
  const status = qualifiedColumn(purchases, purchases.status);
  return sql`case
    when ${status} = 'cancelled' then 0
    when ${status} = 'closed' then floor((2 * ${total}::numeric * round(${settled} * 100) + ${orderedCenti}) / (2 * ${orderedCenti}))
    else ${total}
  end`;
}
