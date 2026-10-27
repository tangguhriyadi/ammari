// Local preview of every email the system sends (docs/plans/email-design.md §5): renders each one
// with sample data into <repo>/.email-preview/ (git-ignored) as .html and .txt, plus an index.html
// to open in a browser. Dev only: a script, never imported by an app, sends nothing, reads no
// database and calls no API. The logo URL points at the storefront (EMAIL_PREVIEW_SITE_ORIGIN,
// default https://ammari.id), so the browser loads it from there like a mail client would.
//
//   pnpm --filter @ammari/commerce emails:preview

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { emailLogoUrl, escapeHtml, renderSignInCodeEmail, renderStaffInviteEmail, type RenderedEmail } from "@ammari/email";
import {
  renderCancelledEmail,
  renderCreatedEmail,
  renderDeliveredEmail,
  renderOwnerPaidEmail,
  renderPaidEmail,
  renderShippedEmail,
  type CustomerOrderEmailView,
} from "../src/emails/templates";

if (process.env.NODE_ENV === "production") {
  console.error("emails:preview is a development tool; refusing to run with NODE_ENV=production.");
  process.exit(1);
}

const siteOrigin = process.env.EMAIL_PREVIEW_SITE_ORIGIN?.trim() || "https://ammari.id";
const logoUrl = emailLogoUrl(siteOrigin);
const siteHost = new URL(siteOrigin).host;
const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.email-preview");

const now = new Date();
const inMinutes = (minutes: number) => new Date(now.getTime() + minutes * 60_000);

const order: CustomerOrderEmailView = {
  orderNo: "ORD-202612-0007",
  greetingName: "Siti",
  lines: [
    { productName: "Haura Dress", colorName: "Beige", sizeLabel: "M", qty: 2, lineTotal: 518_000, listLineTotal: 598_000 },
    { productName: "Khimar Syar'i", colorName: "Hitam", sizeLabel: "All Size", qty: 1, lineTotal: 129_000, listLineTotal: null },
  ],
  totals: { subtotal: 647_000, shipping: 75_000, shippingCost: 95_000, shippingSubsidy: 20_000, discount: 20_000, total: 702_000 },
  courierLabel: "JNE Reguler",
  address: { recipientName: "Siti Aminah", phone: "+6281234567890", addressText: "Jl. Melati No. 5 RT 01/02, Kelurahan Contoh, Kecamatan Contoh, Kota Bandung, Jawa Barat 40111" },
  orderUrl: `${siteOrigin}/orders/ORD-202612-0007?t=contoh`,
  loginUrl: `${siteOrigin}/login/link?token=contoh`,
  siteHost,
  whatsappNumber: "6288808541442",
  logoUrl,
};

const owner = (variant: "paid" | "stock_short" | "after_cancel") =>
  renderOwnerPaidEmail({
    orderNo: order.orderNo,
    variant,
    lines: order.lines,
    totals: order.totals,
    courierLabel: order.courierLabel,
    paidAt: now,
    buyer: { name: "Siti Aminah", email: "siti@example.test", phone: "+6281234567890" },
    address: order.address,
    adminOrderUrl: "https://admin.example.test/orders/contoh",
    logoUrl,
  });

const emails: { file: string; title: string; email: RenderedEmail }[] = [
  { file: "otp-customer", title: "Kode masuk (pelanggan)", email: renderSignInCodeEmail({ audience: "customer", code: "482915", expiresAt: inMinutes(5), validMinutes: 5, logoUrl }) },
  { file: "otp-staff", title: "Kode masuk (staf)", email: renderSignInCodeEmail({ audience: "staff", code: "730164", expiresAt: inMinutes(5), validMinutes: 5, logoUrl }) },
  {
    file: "staff-invite",
    title: "Undangan staf",
    email: renderStaffInviteEmail({ to: "rina@example.test", name: "Rina", roleName: "Packing/Gudang", loginUrl: "https://admin.example.test", inviteExpiresAt: inMinutes(7 * 24 * 60), logoUrl }),
  },
  { file: "order-created", title: "Pesanan dibuat (menunggu pembayaran)", email: renderCreatedEmail({ ...order, paymentDeadline: inMinutes(60), paymentUrl: "https://pay.example.test/contoh" }) },
  { file: "order-paid", title: "Pembayaran diterima", email: renderPaidEmail(order, "confirmed") },
  { file: "order-paid-review", title: "Pembayaran diterima, perlu dicek", email: renderPaidEmail({ ...order, loginUrl: null }, "review") },
  { file: "order-cancelled-expired", title: "Dibatalkan (batas bayar lewat)", email: renderCancelledEmail({ ...order, loginUrl: null, reason: "payment_expired", paymentDeadline: now }) },
  { file: "order-cancelled-admin-paid", title: "Dibatalkan setelah dibayar", email: renderCancelledEmail({ ...order, loginUrl: null, reason: "admin_paid", paymentDeadline: null }) },
  { file: "order-shipped", title: "Pesanan dikirim", email: renderShippedEmail({ ...order, loginUrl: null, courier: "JNE", trackingNumber: "JNE1234567890" }) },
  { file: "order-delivered", title: "Pesanan sampai", email: renderDeliveredEmail({ ...order, loginUrl: null, returnsUrl: `${siteOrigin}/returns-exchange` }) },
  { file: "owner-paid", title: "Pemilik: pesanan dibayar", email: owner("paid") },
  { file: "owner-stock-short", title: "Pemilik: dibayar, stok kurang", email: owner("stock_short") },
  { file: "owner-after-cancel", title: "Pemilik: dibayar setelah dibatalkan", email: owner("after_cancel") },
];

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
for (const { file, email } of emails) {
  writeFileSync(path.join(outDir, `${file}.html`), email.html);
  writeFileSync(path.join(outDir, `${file}.txt`), `Subjek: ${email.subject}\n\n${email.text}`);
}
const items = emails
  .map(({ file, title, email }) => `<li><a href="${file}.html">${escapeHtml(title)}</a> (<a href="${file}.txt">teks</a>)<br><small>${escapeHtml(email.subject)}</small></li>`)
  .join("");
writeFileSync(
  path.join(outDir, "index.html"),
  `<!doctype html><html lang="id"><head><meta charset="utf-8"><title>Pratinjau email Ammari</title></head>` +
    `<body style="font-family:system-ui,sans-serif;max-width:640px;margin:32px auto;padding:0 16px;line-height:1.6">` +
    `<h1>Pratinjau email Ammari</h1><p>Contoh data, bukan data asli. Logo dari ${escapeHtml(siteOrigin)}. Mode gelap: ubah tampilan sistem ke gelap lalu buka di Safari.</p><ul>${items}</ul></body></html>`,
);
console.log(`Wrote ${emails.length} emails to ${outDir}\nOpen ${path.join(outDir, "index.html")}`);
