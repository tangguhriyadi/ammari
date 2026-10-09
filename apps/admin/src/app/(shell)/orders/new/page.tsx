import { PageHeader, Breadcrumb } from "@ammari/ui";
import { requirePermission } from "@/lib/auth/require-permission";
import { listChannels, listOrderableVariants } from "@/lib/orders/queries";
import { rootCrumbs } from "@/lib/nav/breadcrumb";
import { OrderForm } from "../_components/order-form";

export default async function NewOrderPage() {
  await requirePermission("orders.manage");

  const [channels, variants] = await Promise.all([listChannels(), listOrderableVariants()]);

  return (
    <>
      <Breadcrumb items={[...rootCrumbs("/orders"), { label: "Catat pesanan" }]} />
      <PageHeader title="Catat pesanan" description="Pesanan manual dari WhatsApp, Instagram, atau offline." />
      <OrderForm channels={channels} variants={variants} />
    </>
  );
}
