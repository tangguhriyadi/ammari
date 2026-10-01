import { Cormorant, Inter } from "next/font/google";

/** Body text, UI chrome, labels, table text, and all headings EXCEPT the wordmark and page
 * titles >=24px (see the plan's typography revision — thin serifs are hard to read at small
 * sizes on a phone, and the owner uses the admin mostly on her phone). */
export const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

/** Reserved for the AMMARI wordmark and page titles (PageHeader's `title`) at 24px+ only. */
export const cormorant = Cormorant({
  subsets: ["latin"],
  weight: ["300", "500"],
  variable: "--font-cormorant",
  display: "swap",
});

/** Apply to the root `<html>` element so both font CSS variables are available everywhere. */
export const fontVariables = `${inter.variable} ${cormorant.variable}`;
