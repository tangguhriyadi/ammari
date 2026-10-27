// The Ammari look in email (docs/plans/email-design.md §2). CLAUDE.md's visual identity: gray red
// #695A5A, white, black; muted earth tones only.

/** Light-mode colours. Every inline style in every email uses these exact strings: the dark-mode
 * stylesheet in ./layout.ts matches on them, so a new colour needs a dark counterpart there too. */
export const EMAIL_COLOR = {
  brand: "#695A5A",
  text: "#000000",
  muted: "#6B6161",
  line: "#E7E2E2",
  page: "#F6F4F4",
  white: "#FFFFFF",
  highlight: "#F6F3F1",
} as const;

/** Body text: Inter (the storefront's font) where installed, then each platform's system sans. No
 * web font is loaded: Outlook on Windows falls back to Times New Roman when it meets one. */
export const EMAIL_FONT = "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
/** The AMMARI wordmark: Cormorant (the storefront's wordmark font) where installed, else a classic
 * serif. */
export const EMAIL_SERIF_FONT = "Cormorant,'Cormorant Garamond',Georgia,'Times New Roman',serif";
/** Sign-in codes: a monospace face keeps 0/O and 1/l apart. */
export const EMAIL_MONO_FONT = "'SF Mono',Menlo,Consolas,'Liberation Mono','Courier New',monospace";

/** The contact shown at the foot of every email (owner request, email design pass). */
export const EMAIL_CONTACT = {
  email: "ammariofc@gmail.com",
  whatsapp: "+62 888 0854 1442",
} as const;

/** The storefront's own logo file (docs/design/storefront.md §9, the same PNG the header shows),
 * public wherever the storefront is. */
export const EMAIL_LOGO_PATH = "/logos/ammari-primary.png";

/** The logo's absolute URL on the storefront, or null when it would not load in a mail client:
 * only https is used, so a local `http://localhost` origin keeps the text wordmark. */
export function emailLogoUrl(storefrontOrigin: string | null | undefined): string | null {
  if (!storefrontOrigin) return null;
  try {
    const url = new URL(EMAIL_LOGO_PATH, storefrontOrigin);
    if (url.protocol === "https:") return url.href;
    if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") console.warn("[emails] site origin is not https; emails go out without the logo", { origin: url.origin });
    return null;
  } catch {
    console.warn("[emails] site origin is not a URL; emails go out without the logo");
    return null;
  }
}
