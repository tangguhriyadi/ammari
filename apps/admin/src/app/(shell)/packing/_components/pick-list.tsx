import { memo } from "react";
import { ProductImage } from "@/app/(shell)/products/_components/product-image";
import type { PackingPickListItem } from "@/lib/packing/queries";

// Memoized — PackingList re-renders its whole row list on every checkbox tap (selection state
// lives one level up), but each row's own `items` array is a stable reference across that
// re-render; without this, toggling one order's checkbox would still re-render and
// re-reconcile every OTHER visible order's pick list (including its thumbnail <img>s) on a
// page this codebase explicitly treats as tap-heavy/mobile-first.
export const PickList = memo(function PickList({ items }: { items: PackingPickListItem[] }) {
  return (
    <ul className="flex flex-col gap-2">
      {items.map((item) => (
        <li key={item.sku} className="flex items-center gap-3">
          <ProductImage src={item.thumbnailUrl} alt="" className="size-10 shrink-0 rounded-md object-cover" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-neutral-900">
              {item.productName} <span className="text-neutral-600">· {item.colorName} · {item.size === "ALLSIZE" ? "All Size" : item.size}</span>
            </p>
            <p className="truncate text-sm text-neutral-600">{item.sku}</p>
          </div>
          <span className="shrink-0 text-base font-semibold tabular-nums text-neutral-900">{item.qty}x</span>
        </li>
      ))}
    </ul>
  );
});
