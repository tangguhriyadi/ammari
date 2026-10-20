"use client";

import { useEffect, useState } from "react";
import { CART_STATUS_EVENT, liveRegionText } from "@/lib/cart/count-event";

/** The `/cart` page's screen-reader status region: always mounted (a region inserted together
 * with its text is not reliably announced), filled by `announceCartStatus` from the lines, which
 * may unmount themselves (a removed line) right after announcing. */
export function CartLiveRegion() {
  const [announcement, setAnnouncement] = useState({ text: "", sequence: 0 });

  useEffect(() => {
    function handleStatus(event: Event) {
      const text = (event as CustomEvent<string>).detail;
      setAnnouncement((previous) => ({ text, sequence: previous.sequence + 1 }));
    }
    window.addEventListener(CART_STATUS_EVENT, handleStatus);
    return () => window.removeEventListener(CART_STATUS_EVENT, handleStatus);
  }, []);

  return (
    <p role="status" className="sr-only">
      {liveRegionText(announcement.text, announcement.sequence)}
    </p>
  );
}
