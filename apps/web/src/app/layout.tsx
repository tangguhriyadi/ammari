import type { Metadata } from "next";
import { fontVariables } from "@ammari/ui/fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ammari",
  description: "Ammari — syar'i gamis",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="id" className={fontVariables}>
      <body className="font-sans text-base">{children}</body>
    </html>
  );
}
