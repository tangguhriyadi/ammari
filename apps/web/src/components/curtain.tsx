"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef, type ReactNode, type TransitionEvent } from "react";

/** Matches `.curtain`'s transition in globals.css. */
export const CURTAIN_DURATION_MS = 300;
// Settles the phase if `transitionend` never arrives (an ancestor is `display: none`, e.g. the
// mobile menu at `lg`, the tab is hidden, or the transition got interrupted).
const FALLBACK_MS = CURTAIN_DURATION_MS + 100;

/** closed: not rendered. entering: mounted at 0fr for one frame so the open transition has a
 * start value. opening/closing: animating. open: settled at full height (content not clipped,
 * so focus outlines show). */
export type CurtainPhase = "closed" | "entering" | "opening" | "open" | "closing";

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
}

/** Where an animating phase comes to rest; any other phase stays as it is. */
function settledPhase(current: CurtainPhase): CurtainPhase {
  return current === "opening" ? "open" : current === "closing" ? "closed" : current;
}

interface CurtainProps extends Omit<ComponentPropsWithoutRef<"div">, "children" | "onTransitionEnd"> {
  open: boolean;
  children: ReactNode;
  /** Classes for the content box (padding, background...): it sits inside the clip, so padding
   * collapses with it. `className` styles the outer box, whose edge is the curtain's edge. */
  contentClassName?: string;
  /** Fires once the panel has reached full height (after the animation, or right away under
   * reduced motion), i.e. when its final layout can be measured or scrolled to. */
  onOpened?: () => void;
}

/** A disclosure panel that unrolls from its top edge like a blind (and rolls back up on close),
 * animating its real `auto` height via `grid-template-rows: 0fr -> 1fr`. Content is unmounted
 * only after the close animation finishes. Shared by the mobile menu and the PDP accordions. */
export function Curtain({ open, children, className, contentClassName, onOpened, ...rest }: CurtainProps) {
  const [phase, setPhase] = useState<CurtainPhase>(open ? "open" : "closed");
  const [prevOpen, setPrevOpen] = useState(open);
  const ref = useRef<HTMLDivElement>(null);
  const onOpenedRef = useRef(onOpened);
  useLayoutEffect(() => {
    onOpenedRef.current = onOpened;
  });

  // Derive the phase from the `open` prop during render (React's "adjust state when a prop
  // changes" pattern), so the first render after a toggle already carries the new phase. The
  // matchMedia read only ever runs on a client-side toggle, never during SSR or hydration.
  if (open !== prevOpen) {
    setPrevOpen(open);
    const instant = prefersReducedMotion();
    if (open) setPhase(instant || phase === "open" ? "open" : phase === "closing" ? "opening" : "entering");
    // Still at 0fr while entering: nothing to roll up, and no transition would ever end.
    else setPhase(instant || phase === "closed" || phase === "entering" ? "closed" : "closing");
  }

  useLayoutEffect(() => {
    if (phase !== "entering") return;
    // Commit the 0fr start value to computed style, then switch to 1fr on the next frame.
    void ref.current?.offsetHeight;
    const frame = requestAnimationFrame(() => setPhase((current) => (current === "entering" ? "opening" : current)));
    return () => cancelAnimationFrame(frame);
  }, [phase]);

  useEffect(() => {
    if (phase !== "opening" && phase !== "closing") return;
    const timer = setTimeout(() => setPhase(settledPhase), FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  useEffect(() => {
    if (phase === "open") onOpenedRef.current?.();
  }, [phase]);

  function handleTransitionEnd(event: TransitionEvent<HTMLDivElement>) {
    // Only the curtain's own height transition: not ones bubbling up from the content, nor any
    // other property a consumer's classes might transition on this element.
    if (event.target !== event.currentTarget || event.propertyName !== "grid-template-rows") return;
    setPhase(settledPhase);
  }

  if (phase === "closed") return null;

  return (
    <div
      ref={ref}
      {...rest}
      data-state={phase}
      // Not reachable while rolling up (already logically closed), nor in the 0fr frame before
      // unrolling, when a fast Tab could land on an invisible link.
      inert={phase === "closing" || phase === "entering" || undefined}
      onTransitionEnd={handleTransitionEnd}
      className={className ? `curtain ${className}` : "curtain"}
    >
      <div className="curtain-clip">
        <div className={contentClassName}>{children}</div>
      </div>
    </div>
  );
}
