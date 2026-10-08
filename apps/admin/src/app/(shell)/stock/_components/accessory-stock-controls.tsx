"use client";

import { useState } from "react";
import { Button } from "@ammari/ui";
import { AdjustAccessoryDialog } from "./adjust-accessory-dialog";

export function AccessoryStockControls({ accessoryId }: { accessoryId: string }) {
  const [adjustOpen, setAdjustOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="secondary" onClick={() => setAdjustOpen(true)}>
        Sesuaikan stok
      </Button>
      <AdjustAccessoryDialog accessoryId={accessoryId} open={adjustOpen} onOpenChange={setAdjustOpen} />
    </>
  );
}
