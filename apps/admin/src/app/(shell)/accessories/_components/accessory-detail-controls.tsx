"use client";

import { useState } from "react";
import { Button } from "@ammari/ui";
import { PurchaseAccessoryDialog } from "./purchase-accessory-dialog";
import { AdjustAccessoryDialog } from "./adjust-accessory-dialog";

export function AccessoryDetailControls({ accessoryId }: { accessoryId: string }) {
  const [purchaseOpen, setPurchaseOpen] = useState(false);
  const [adjustOpen, setAdjustOpen] = useState(false);
  return (
    <>
      <Button type="button" onClick={() => setPurchaseOpen(true)}>
        Catat pembelian
      </Button>
      <Button type="button" variant="secondary" onClick={() => setAdjustOpen(true)}>
        Sesuaikan stok
      </Button>
      <PurchaseAccessoryDialog accessoryId={accessoryId} open={purchaseOpen} onOpenChange={setPurchaseOpen} />
      <AdjustAccessoryDialog accessoryId={accessoryId} open={adjustOpen} onOpenChange={setAdjustOpen} />
    </>
  );
}
