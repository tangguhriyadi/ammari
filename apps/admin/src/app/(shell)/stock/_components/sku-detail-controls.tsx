"use client";

import { useState } from "react";
import { Button } from "@ammari/ui";
import { AdjustStockDialog } from "./adjust-stock-dialog";

export function SkuDetailControls({ sku }: { sku: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
        Sesuaikan stok
      </Button>
      <AdjustStockDialog sku={sku} open={open} onOpenChange={setOpen} />
    </>
  );
}
