"use client";

import { useState } from "react";
import { Button } from "@ammari/ui";
import { AdjustFabricDialog, type AdjustFabricColorOption } from "./adjust-fabric-dialog";
import { MoveFabricColourDialog, type MoveFabricColourOption } from "./move-fabric-colour-dialog";

export function FabricStockControls({
  fabricId,
  colorOptions,
  requireColor,
  moveSources,
  moveTargets,
}: {
  fabricId: string;
  colorOptions: AdjustFabricColorOption[];
  requireColor: boolean;
  /** "Pindahkan ke warna": buckets holding stock, and the active colours they can move into. */
  moveSources: MoveFabricColourOption[];
  moveTargets: MoveFabricColourOption[];
}) {
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  // Something to move and somewhere else to move it.
  const canMove = moveSources.some((source) => moveTargets.some((target) => target.fabricColorId !== source.fabricColorId));
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
      {canMove && (
        <>
          <Button type="button" variant="secondary" onClick={() => setMoveOpen(true)}>
            Pindahkan ke warna
          </Button>
          <MoveFabricColourDialog fabricId={fabricId} sources={moveSources} targets={moveTargets} open={moveOpen} onOpenChange={setMoveOpen} />
        </>
      )}
    </>
  );
}
