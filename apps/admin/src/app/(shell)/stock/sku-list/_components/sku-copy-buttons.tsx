"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@ammari/ui";

// "Salin tabel" (tab-separated, pastes as columns in Google Sheets or Excel) and "Salin SKU" (one
// SKU per line). Same refused-clipboard handling as components/orders/copy-value.tsx.

type Copied = "table" | "sku" | "failed" | null;

export function SkuCopyButtons({ tableText, skuText }: { tableText: string; skuText: string }) {
  const [copied, setCopied] = useState<Copied>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  async function copy(kind: "table" | "sku") {
    if (timer.current) clearTimeout(timer.current);
    // Cleared first so a second click in a row is announced again.
    setCopied(null);
    try {
      if (!navigator.clipboard) throw new Error("no clipboard");
      await navigator.clipboard.writeText(kind === "table" ? tableText : skuText);
      setCopied(kind);
    } catch (error) {
      console.warn("[sku-list] copy to clipboard failed", error instanceof Error ? error.name : typeof error);
      setCopied("failed");
    }
    timer.current = setTimeout(() => setCopied(null), 2_000);
  }

  const icon = (kind: "table" | "sku") => (copied === kind ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" variant="secondary" onClick={() => copy("table")}>
        {icon("table")}
        {copied === "table" ? "Tabel tersalin" : "Salin tabel"}
      </Button>
      <Button type="button" variant="secondary" onClick={() => copy("sku")}>
        {icon("sku")}
        {copied === "sku" ? "SKU tersalin" : "Salin SKU"}
      </Button>
      <span role="status" aria-live="polite" className={copied === "failed" ? "text-sm text-danger-700" : "sr-only"}>
        {copied === "table" ? "Tabel tersalin." : copied === "sku" ? "SKU tersalin." : copied === "failed" ? "Gagal menyalin. Gunakan Unduh CSV." : ""}
      </span>
    </div>
  );
}
