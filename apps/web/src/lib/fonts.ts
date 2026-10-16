import { Cormorant_Garamond, Jost } from "next/font/google";

// docs/design/storefront.md §3 "Typography" — self-hosted via next/font (display: swap), NOT
// apps/admin's own Inter/Cormorant pair (packages/ui/src/fonts/index.ts): the storefront spec
// names "Cormorant Garamond" specifically (a distinct Google Fonts family from plain
// "Cormorant", which admin uses) and "Jost" for UI/body text (never Inter on this app). Kept
// local to apps/web rather than added to the shared @ammari/ui font module, since admin's own
// fonts must stay untouched.

/** Display/headings — weights 300/400/500/600/700 only, per the spec's typography table. */
export const cormorantGaramond = Cormorant_Garamond({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-cormorant-garamond",
  display: "swap",
});

/** UI chrome, body text, eyebrows, buttons — weights 300/400/500 only. */
export const jost = Jost({
  subsets: ["latin"],
  weight: ["300", "400", "500"],
  variable: "--font-jost",
  display: "swap",
});

/** Applied to the root `<html>` element so both font CSS variables are available everywhere —
 * globals.css's storefront `@theme` block then points `--font-serif`/`--font-sans` at them. */
export const storefrontFontVariables = `${cormorantGaramond.variable} ${jost.variable}`;
