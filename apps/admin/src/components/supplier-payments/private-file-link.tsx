"use client";

import { useState } from "react";
import { Dialog } from "@ammari/ui";
import type { PrivateFileRef } from "@/lib/supplier-payments/payment-records";

// Opens a payment proof or nota (docs/plans/purchase-payments.md §9 "Proof viewer"). Both go
// through /api/private-files/[id], which re-checks the session and permissions on every request
// (A6): a photo in a lightbox, a PDF in a new tab. There is never a storage URL on the page.

/** `label` is the visible text ("Lihat bukti"); `title` names the record ("Bukti BYR-...") and is
 * added for assistive tech, since every row has the same visible text. */
export function PrivateFileLink({ file, label, title }: { file: PrivateFileRef; label: string; title: string }) {
  const [open, setOpen] = useState(false);
  const href = `/api/private-files/${file.id}`;
  const linkClass = "inline-flex min-h-11 items-center text-base font-medium text-brand hover:underline";

  if (file.contentType === "application/pdf") {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={linkClass}>
        {label} (PDF)<span className="sr-only">: {title}, buka di tab baru</span>
      </a>
    );
  }
  return (
    <>
      <button type="button" className={linkClass} onClick={() => setOpen(true)}>
        {label}
        <span className="sr-only">: {title}</span>
      </button>
      <Dialog open={open} onOpenChange={setOpen} title={title} cancelLabel="Tutup">
        {open && (
          // eslint-disable-next-line @next/next/no-img-element -- a permission-checked admin route, not a static asset
          <img src={href} alt={title} className="max-h-[70vh] w-full rounded object-contain outline-1 -outline-offset-1 outline-black/5" />
        )}
        <a href={href} target="_blank" rel="noopener noreferrer" className={`${linkClass} mt-2`}>
          Buka di tab baru
        </a>
      </Dialog>
    </>
  );
}
