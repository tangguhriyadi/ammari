import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ammari",
  description: "Ammari — syar'i gamis",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
