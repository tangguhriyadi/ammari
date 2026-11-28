import type { ReactNode } from "react";
import { TikTokSubTabs } from "./_components/tiktok-sub-tabs";

export default function TikTokLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <TikTokSubTabs />
      {children}
    </>
  );
}
