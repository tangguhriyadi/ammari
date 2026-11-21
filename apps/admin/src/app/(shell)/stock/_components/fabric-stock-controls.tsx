"use client";

import { useState } from "react";
import { Button } from "@ammari/ui";
import { AdjustFabricDialog, type AdjustFabricColorOption } from "./adjust-fabric-dialog";

export function FabricStockControls({
  fabricId,
  colorOptions,
  requireColor,
}: {
  fabricId: string;
  colorOptions: AdjustFabricColorOption[];
  requireColor: boolean;
}) {
  const [adjustOpen, setAdjustOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="secondary" onClick={() => setAdjustOpen(true)}>
        Sesuaikan stok
      </Button>
      {/* Remounted when the fabric gains/loses its active colours, so a preselected "Tanpa warna"
          can never survive into a state where a colour must be picked explicitly. */}
      <AdjustFabricDialog
        key={requireColor ? "require-color" : "optional-color"}
        fabricId={fabricId}
        colorOptions={colorOptions}
        requireColor={requireColor}
        open={adjustOpen}
        onOpenChange={setAdjustOpen}
      />
    </>
  );
}
