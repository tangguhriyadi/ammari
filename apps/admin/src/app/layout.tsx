import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ammari Admin",
  description: "Ammari — admin dashboard",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
