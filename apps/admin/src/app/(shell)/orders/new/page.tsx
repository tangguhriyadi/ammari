import { PageHeader, Breadcrumb } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { listChannels, listOrderableVariants } from "@/lib/orders/queries";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { loadManualPaymentOptions } from "@/lib/orders/manual-payment";
import { getTikTokConnectionView } from "@ammari/commerce/tiktok";
import { defaultDb } from "@/lib/db";
import { OrderForm, type TikTokEntryNotice } from "../_components/order-form";

export default async function NewOrderPage() {
  await requirePermission("orders.manage");

  const [channels, variants, paymentOptions, tiktok] = await Promise.all([listChannels(), listOrderableVariants(), loadManualPaymentOptions(), getTikTokConnectionView(defaultDb)]);
  // Q16 (docs/plans/tiktok-shop-integration.md): a TikTok order typed by hand while the shop is
  // connected gets a warning, never a block. No token column is read.
  const tiktokNotice: TikTokEntryNotice = tiktok?.status === "active" ? (tiktok.ordersApplyEnabled ? "applying" : "connected") : null;

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/orders"), { label: "Catat pesanan" }]} />
      <PageHeader title="Catat pesanan" description="Pesanan manual dari WhatsApp, Instagram, atau offline." />
      <OrderForm channels={channels} variants={variants} paymentOptions={paymentOptions} tiktokNotice={tiktokNotice} />
    </>
  );
}
