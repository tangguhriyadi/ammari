// Contract between the "Panduan ukuran" link (product-purchase-panel.tsx) and the accordions
// (accordions.tsx), which live in different client subtrees (the accordions flow into the panel
// as a server-built slot), so they talk through a window event rather than shared state.
export const SIZE_GUIDE_ACCORDION_ID = "ukuran";
export const SIZE_CHART_HEADING_ID = "panduan-ukuran-heading";
export const OPEN_ACCORDION_EVENT = "ammari:open-accordion";

export interface OpenAccordionDetail {
  /** The accordion item to open (no-op if already open). */
  accordionId: string;
  /** The element to scroll to and focus once the panel is laid out. */
  targetId: string;
}
