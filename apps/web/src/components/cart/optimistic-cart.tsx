"use client";

import { createContext, useContext, useEffect, useOptimistic, useRef, type ReactNode } from "react";
import type { CartLine } from "@ammari/commerce/cart";
import { formatPriceIdr } from "@/lib/format";

// The `/cart` page's optimistic layer (owner request after the 2026-10-21 sandbox run: the
// stepper felt slow). A tap on "+" / "-" / × changes the quantity, the line total, the subtotal
// and the piece count on the current frame; the server action then re-checks stock and caps and
// answers with a fresh render of the page (the action calls `refresh()`), which replaces the
// optimistic values when the transition ends. A refusal ends the transition without new data, so
// the optimistic values fall back to the server's own (useOptimistic) and the line shows the
// server's message. The figures here are display only: prices, stock and caps are decided by the
// server (plan §4.2).

/** `qty: null` removes the line. */
export interface OptimisticCartUpdate {
  sku: string;
  qty: number | null;
}

interface OptimisticCart {
  lines: CartLine[];
  pieceCount: number;
  subtotal: number;
  /** The latest server-rendered piece count (what the header shows again after a refusal). Read
   * when called, so a tap's late refusal never brings back a count from before a newer render. */
  serverPieceCount: () => number;
  /** Counts the page's in-flight cart writes: a write's own answer goes to the header only when it
   * is the last one, so the badge never steps back through intermediate counts. `endWrite` is true
   * when no other write is still on its way. */
  beginWrite: () => void;
  endWrite: () => boolean;
  /** Must be called inside a transition (the line's own). */
  apply: (update: OptimisticCartUpdate) => void;
}

const OptimisticCartContext = createContext<OptimisticCart | null>(null);

function reduce(lines: CartLine[], update: OptimisticCartUpdate): CartLine[] {
  if (update.qty === null) return lines.filter((line) => line.sku !== update.sku);
  const qty = update.qty;
  return lines.map((line) => (line.sku === update.sku ? { ...line, qty, lineTotal: line.unitPrice * qty } : line));
}

/** Same rules as the server's cart view (@ammari/commerce/cart `loadCartView`). */
export function cartFigures(lines: readonly CartLine[]): { pieceCount: number; subtotal: number } {
  return {
    pieceCount: lines.reduce((sum, line) => sum + line.qty, 0),
    subtotal: lines.filter((line) => line.status === "ok" || line.status === "insufficient").reduce((sum, line) => sum + line.lineTotal, 0),
  };
}

export function OptimisticCartProvider({ lines, children }: { lines: CartLine[]; children: ReactNode }) {
  const [optimisticLines, apply] = useOptimistic(lines, reduce);
  const serverCount = useRef(cartFigures(lines).pieceCount);
  useEffect(() => {
    serverCount.current = cartFigures(lines).pieceCount;
  }, [lines]);
  const pending = useRef(0);
  const value: OptimisticCart = {
    lines: optimisticLines,
    ...cartFigures(optimisticLines),
    serverPieceCount: () => serverCount.current,
    beginWrite: () => {
      pending.current += 1;
    },
    endWrite: () => {
      pending.current = Math.max(0, pending.current - 1);
      return pending.current === 0;
    },
    apply,
  };
  return <OptimisticCartContext.Provider value={value}>{children}</OptimisticCartContext.Provider>;
}

/** Null outside a provider (a line rendered on its own, e.g. in a unit test). */
export function useOptimisticCart(): OptimisticCart | null {
  return useContext(OptimisticCartContext);
}

export function CartSubtotal({ fallback }: { fallback: number }) {
  const cart = useOptimisticCart();
  return <>{formatPriceIdr(cart?.subtotal ?? fallback)}</>;
}

export function CartPieceCount({ fallback }: { fallback: number }) {
  const cart = useOptimisticCart();
  return <>{cart?.pieceCount ?? fallback} barang</>;
}
