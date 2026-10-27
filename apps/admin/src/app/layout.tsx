import type { Metadata } from "next";
import { fontVariables } from "@ammari/ui/fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ammari Admin",
  description: "Ammari | admin dashboard",
  // Never indexed (also robots.txt and the X-Robots-Tag header, next.config.ts).
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="id" className={fontVariables}>
      <body className="font-sans text-base">{children}</body>
    </html>
  );
}
