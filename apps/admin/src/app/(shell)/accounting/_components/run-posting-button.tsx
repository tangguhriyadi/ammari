"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, useToast } from "@ammari/ui";
import { runPostingAction } from "../actions";

// Runs the posting engine now. The server re-checks accounting.manage; the page only shows this
// button to staff who hold it.

export function RunPostingButton() {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  function handleClick() {
    startTransition(async () => {
      const result = await runPostingAction();
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      const { insertedCount, reversedCount, issueCount } = result.data;
      toast.success(`Posting selesai: ${insertedCount} jurnal baru, ${reversedCount} jurnal dibalik, ${issueCount} perlu dicek.`);
      router.refresh();
    });
  }

  return (
    <Button type="button" onClick={handleClick} loading={pending}>
      Posting sekarang
    </Button>
  );
}
