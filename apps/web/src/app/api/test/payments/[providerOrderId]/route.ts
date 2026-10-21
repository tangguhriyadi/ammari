import { asc, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { fabricColors, orderItems, orders, payments, products, productVariants } from "@ammari/db/schema";
import { buildPaymentLines, type PaymentLine } from "@ammari/commerce/payments";
import { isCartEnabled } from "@/lib/cart-flag";
import { defaultDb } from "@/lib/db";
import { isE2eFixturesRequestAllowed } from "@/lib/fixtures/e2e-fixtures-gate";
import { formatPriceIdr } from "@/lib/format";

// e2e-only stand-in for the payment gateway's page (docs/plans/cart-checkout.md §13, session 10):
// the fake payment provider (@ammari/commerce/payments, PAYMENT_PROVIDER=fake) sends the buyer
// here after "Bayar sekarang". Behind the same three fail-closed conditions as the fixtures
// route (non-production build, E2E_TEST_LOGIN=true, a loopback Host) plus the cart flag, and
// deploy/Caddyfile blocks /api/test/* at the edge anyway.
//
// READ-ONLY by design: it shows what the gateway would charge (the same buildPaymentLines the real
// provider gets, so the "Ongkir" line can be checked end to end) and links back to the finish
// page, simulating only the gateway's redirect. It never marks anything paid: "paid" may only come
// from a verified server-to-server notification (CLAUDE.md, plan D6), which session 11 builds;
// a browser request here can never be that.

export const dynamic = "force-dynamic";

const PROVIDER_ORDER_ID_PATTERN = /^[A-Z0-9-]{0,16}ORD-[0-9]{6}-[0-9]{4,}-[0-9]+$/;

function notFound(): Response {
  return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

function sizeLabel(size: string): string {
  return size === "ALLSIZE" ? "All Size" : size;
}

function page(params: { orderNo: string; lines: PaymentLine[]; grossAmount: number }): string {
  const rows = params.lines
    .map(
      (line) =>
        `<tr data-line-id="${escapeHtml(line.id)}"><td>${escapeHtml(line.name)}</td><td>${line.quantity}</td><td>${escapeHtml(formatPriceIdr(line.price * line.quantity).replace("Rp-", "-Rp"))}</td></tr>`,
    )
    .join("");
  const finishHref = `/checkout/finish?order=${encodeURIComponent(params.orderNo)}`;
  return `<!doctype html>
<html lang="id">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>Pembayaran uji</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 480px; margin: 24px auto; padding: 0 16px;">
<h1>Pembayaran uji</h1>
<p>Halaman ini hanya untuk pengujian. Tidak ada pembayaran yang diproses.</p>
<p>Pesanan <strong data-testid="fake-payment-order">${escapeHtml(params.orderNo)}</strong></p>
<table aria-label="Rincian pembayaran" style="width: 100%; border-collapse: collapse;">
<thead><tr><th align="left">Item</th><th align="left">Jumlah</th><th align="left">Harga</th></tr></thead>
<tbody>${rows}</tbody>
</table>
<p>Total <strong data-testid="fake-payment-total">${escapeHtml(formatPriceIdr(params.grossAmount))}</strong></p>
<p><a href="${escapeHtml(finishHref)}">Kembali ke toko</a></p>
</body>
</html>`;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ providerOrderId: string }> }): Promise<Response> {
  const allowed = isE2eFixturesRequestAllowed({
    nodeEnv: process.env.NODE_ENV,
    e2eTestLoginFlag: process.env.E2E_TEST_LOGIN,
    host: request.headers.get("host"),
  });
  if (!allowed || !isCartEnabled()) return notFound();

  const { providerOrderId } = await params;
  if (!PROVIDER_ORDER_ID_PATTERN.test(providerOrderId)) return notFound();

  const [payment] = await defaultDb
    .select({
      orderId: orders.id,
      orderNo: orders.orderNo,
      shipping: orders.shippingAmount,
      discount: orders.discountAmount,
      grossAmount: payments.grossAmount,
    })
    .from(payments)
    .innerJoin(orders, eq(orders.id, payments.orderId))
    .where(eq(payments.providerOrderId, providerOrderId))
    .limit(1);
  if (!payment) return notFound();

  const items = await defaultDb
    .select({
      sku: orderItems.sku,
      productName: products.name,
      colorName: fabricColors.name,
      size: productVariants.size,
      qty: orderItems.qty,
      unitPrice: orderItems.unitPrice,
    })
    .from(orderItems)
    .innerJoin(productVariants, eq(productVariants.sku, orderItems.sku))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .innerJoin(fabricColors, eq(fabricColors.id, productVariants.fabricColorId))
    .where(eq(orderItems.orderId, payment.orderId))
    .orderBy(asc(orderItems.createdAt), asc(orderItems.sku));

  let lines: PaymentLine[];
  try {
    lines = buildPaymentLines({
      products: items.map((item) => ({
        sku: item.sku,
        name: `${item.productName} ${item.colorName} ${sizeLabel(item.size)}`,
        unitPrice: item.unitPrice,
        qty: item.qty,
      })),
      shippingAmount: payment.shipping,
      discountAmount: payment.discount,
      grossAmount: payment.grossAmount,
    });
  } catch (error) {
    // The lines do not add up to the charged amount (a lost line, or a bug placeOrder should have
    // refused): a readable failure for the e2e run, never a page that looks fine.
    console.error("[test payments] payment lines do not match the order", { orderNo: payment.orderNo, error: error instanceof Error ? error.message : "unknown" });
    return new Response("Payment lines do not match the order", { status: 500, headers: { "Cache-Control": "no-store" } });
  }

  return new Response(page({ orderNo: payment.orderNo, lines, grossAmount: payment.grossAmount }), {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" },
  });
}
