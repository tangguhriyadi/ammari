"use client";

import { useState } from "react";
import { Button } from "@ammari/ui";
import { AdjustFabricDialog } from "./adjust-fabric-dialog";

export function FabricStockControls({ fabricId }: { fabricId: string }) {
  const [adjustOpen, setAdjustOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="secondary" onClick={() => setAdjustOpen(true)}>
        Sesuaikan stok
      </Button>
      <AdjustFabricDialog fabricId={fabricId} open={adjustOpen} onOpenChange={setAdjustOpen} />
    </>
  );
}
