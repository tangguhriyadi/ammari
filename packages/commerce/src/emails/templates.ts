import { DISCOUNT_COLOR_HEX } from "@ammari/db/pricing";
import { SHIPPING_DISPLAY_LABELS, shippingDisplay } from "../shipping/rules";
import { button, details, divider, EMAIL_COLOR, EMAIL_FONT, type EmailSection, heading, link, muted, paragraph, renderEmail, type RenderedEmail } from "@ammari/email";
import { escapeHtml, formatRupiah, formatWib } from "./format";

// Order email templates (docs/plans/cart-checkout.md §8). Pure: a view in, `{ subject, text, html }`
// out, so the same view always renders the same message (a retried send must be byte-identical for
// the provider's idempotency key, ./dispatch.ts). Indonesian, minimal and warm; no em dash; money
// as "Rp259.000"; times in WIB; never the payment gateway or the shipping provider; never cost
// data. The owner email (to store_settings.support_email only) also carries the buyer's contact
// and address.
//
// The page around the content (header, footer with contact, dark mode, client quirks) is the
// shared Ammari layout in @ammari/email (docs/plans/email-design.md); the order rows are this file's.

export interface OrderEmailLine {
  productName: string;
  colorName: string;
  sizeLabel: string;
  qty: number;
  lineTotal: number;
  /** The line at its normal price, when a product discount made it cheaper
   * (`order_items.list_unit_price`); null otherwise. Shown struck through next to `lineTotal`. */
  listLineTotal: number | null;
}

export interface OrderEmailTotals {
  subtotal: number;
  /** The buyer's share of the courier cost (orders.shipping_amount). */
  shipping: number;
  /** The locked quote: courier cost and Ammari's subsidy (null on an order without one). */
  shippingCost: number | null;
  shippingSubsidy: number | null;
  discount: number;
  total: number;
}

export interface OrderEmailAddress {
  recipientName: string;
  phone: string;
  /** One line: street, kecamatan, city, province and kode pos. */
  addressText: string;
}

export interface CustomerOrderEmailView {
  orderNo: string;
  /** The buyer's first name for "Halo Kak ...,", or null for a plain "Halo Kak,". */
  greetingName: string | null;
  lines: OrderEmailLine[];
  totals: OrderEmailTotals;
  /** e.g. "JNE Reguler". */
  courierLabel: string | null;
  address: OrderEmailAddress | null;
  /** "Lihat pesanan" (view-only token link, plan §9.2). */
  orderUrl: string;
  /** "Masuk ke akun" (plan §9.3, session 14): set only on the `created` and `paid` emails of a guest
   * order whose link was issued (dispatch.ts `loginUrlFor`), otherwise null. */
  loginUrl: string | null;
  /** The storefront host, e.g. "ammari.id", for the footer. */
  siteHost: string;
  whatsappNumber: string | null;
  /** The logo mark next to "AMMARI" in the header: an absolute https URL, or null for text only. */
  logoUrl: string | null;
}

export interface CreatedEmailView extends CustomerOrderEmailView {
  paymentDeadline: Date;
  /** The payment page; null when it could not be created (the order page offers it). */
  paymentUrl: string | null;
}

/** Why the `cancelled` email goes out: the payment window ended or the payment was cancelled at the
 * gateway, or staff cancelled the order before (`admin_unpaid`) or after (`admin_paid`) it was paid
 * (session 16, owner decision 45). */
export type CancelledEmailReason = "payment_expired" | "payment_cancelled" | "admin_unpaid" | "admin_paid";

export interface CancelledEmailView extends CustomerOrderEmailView {
  reason: CancelledEmailReason;
  paymentDeadline: Date | null;
}

export interface ShippedEmailView extends CustomerOrderEmailView {
  courier: string | null;
  trackingNumber: string | null;
}

export interface DeliveredEmailView extends CustomerOrderEmailView {
  /** The storefront's "Pengembalian & penukaran" page. */
  returnsUrl: string;
}

export interface OwnerPaidEmailView {
  orderNo: string;
  variant: "paid" | "stock_short" | "after_cancel";
  lines: OrderEmailLine[];
  totals: OrderEmailTotals;
  courierLabel: string | null;
  paidAt: Date | null;
  buyer: { name: string | null; email: string | null; phone: string | null };
  address: OrderEmailAddress | null;
  /** The admin order page, or null when ADMIN_SITE_URL is not set. */
  adminOrderUrl: string | null;
  logoUrl: string | null;
}

export type { RenderedEmail };

// ---------- blocks: one description, rendered as text and as HTML ----------

type Block =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "muted"; text: string }
  | { kind: "button"; label: string; url: string }
  | { kind: "link"; label: string; url: string }
  | { kind: "lines"; lines: OrderEmailLine[] }
  | { kind: "totals"; totals: OrderEmailTotals; savings: number }
  | { kind: "details"; title: string; rows: { label: string; value: string }[] }
  | { kind: "divider" };

const COLOR = { ...EMAIL_COLOR, discount: DISCOUNT_COLOR_HEX };
const FONT = EMAIL_FONT;

function lineLabel(line: OrderEmailLine): string {
  return `${line.colorName}, ${line.sizeLabel} x ${line.qty}`;
}

/** The line's normal price when a product discount made it cheaper, else null. */
function struckLineTotal(line: OrderEmailLine): number | null {
  return line.listLineTotal !== null && line.listLineTotal > line.lineTotal ? line.listLineTotal : null;
}

/** "Hemat" (docs/plans/product-discount.md §9, owner answer 8): what the product discounts took off
 * the normal prices of these lines. The voucher is its own row, not part of this. */
function productSavings(lines: readonly OrderEmailLine[]): number {
  return lines.reduce((sum, line) => sum + ((struckLineTotal(line) ?? line.lineTotal) - line.lineTotal), 0);
}

/** `struck`: the courier cost (shown struck through); `highlight`: the subsidy (owner request after
 * the 2026-10-21 sandbox run: the subsidy must be clearly visible, same rows as the storefront);
 * `savings`: the "Hemat" row, in the discount red. */
type TotalRow = { label: string; value: string; style?: "strong" | "struck" | "highlight" | "savings" };

function totalRows(totals: OrderEmailTotals, savings: number): TotalRow[] {
  const shipping = shippingDisplay({ buyerAmount: totals.shipping, costAmount: totals.shippingCost, subsidyAmount: totals.shippingSubsidy });
  return [
    { label: "Subtotal", value: formatRupiah(totals.subtotal) },
    ...(savings > 0 ? [{ label: "Hemat", value: formatRupiah(savings), style: "savings" as const }] : []),
    ...(shipping.subsidy
      ? [
          { label: SHIPPING_DISPLAY_LABELS.courierCost, value: formatRupiah(shipping.subsidy.courierCost), style: "struck" as const },
          { label: SHIPPING_DISPLAY_LABELS.subsidy, value: `-${formatRupiah(shipping.subsidy.amount)}`, style: "highlight" as const },
        ]
      : []),
    { label: shipping.buyerLabel, value: formatRupiah(shipping.buyerAmount) },
    ...(totals.discount > 0 ? [{ label: "Voucher", value: `-${formatRupiah(totals.discount)}` }] : []),
    { label: "Total", value: formatRupiah(totals.total), style: "strong" as const },
  ];
}

const cell = (style: string, content: string) => `<tr><td style="${style}">${content}</td></tr>`;

function linesSection(lines: OrderEmailLine[]): EmailSection {
  const text = `font-family:${FONT};font-size:15px;line-height:1.6;color:${COLOR.text};`;
  const rows = lines
    .map((line) => {
      const struck = struckLineTotal(line);
      // Discounted: the normal price struck through and muted above the paid price in the
      // discount red (the storefront's look; no CSS variables in email).
      const price =
        struck === null
          ? escapeHtml(formatRupiah(line.lineTotal))
          : `<s style="font-size:13px;color:${COLOR.muted};">${escapeHtml(formatRupiah(struck))}</s><br><span style="color:${COLOR.discount};">${escapeHtml(formatRupiah(line.lineTotal))}</span>`;
      return (
        `<tr><td style="padding:10px 0;border-bottom:1px solid ${COLOR.line};${text}">${escapeHtml(line.productName)}<br><span style="font-size:13px;color:${COLOR.muted};">${escapeHtml(lineLabel(line))}</span></td>` +
        `<td style="padding:10px 0 10px 12px;border-bottom:1px solid ${COLOR.line};${text}text-align:right;white-space:nowrap;vertical-align:top;">${price}</td></tr>`
      );
    })
    .join("");
  return {
    text: lines
      .map((line) => {
        const struck = struckLineTotal(line);
        const normal = struck === null ? "" : ` (harga normal ${formatRupiah(struck)})`;
        return `${line.productName}\n${lineLabel(line)}: ${formatRupiah(line.lineTotal)}${normal}`;
      })
      .join("\n\n"),
    html: cell("padding:0 0 8px;", `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>`),
  };
}

function totalsSection(totals: OrderEmailTotals, savings: number): EmailSection {
  const text = `font-family:${FONT};font-size:15px;line-height:1.6;color:${COLOR.text};`;
  const rows = totalRows(totals, savings)
    .map((row) => {
      if (row.style === "savings") {
        // Only the discount colour, never the body text colour as well: the layout's dark mode
        // matches on `color:#000000` and would turn the row white.
        const savingsStyle = `font-family:${FONT};font-size:15px;line-height:1.6;color:${COLOR.discount};`;
        return (
          `<tr><td style="padding:4px 0;${savingsStyle}">${escapeHtml(row.label)}</td>` +
          `<td style="padding:4px 0 4px 12px;${savingsStyle}text-align:right;white-space:nowrap;">${escapeHtml(row.value)}</td></tr>`
        );
      }
      if (row.style === "highlight") {
        const highlight = `font-family:${FONT};font-size:15px;line-height:1.6;color:${COLOR.brand};font-weight:600;background-color:${COLOR.highlight};`;
        return (
          `<tr><td style="padding:6px 8px;${highlight}">${escapeHtml(row.label)}</td>` +
          `<td style="padding:6px 8px 6px 12px;${highlight}text-align:right;white-space:nowrap;">${escapeHtml(row.value)}</td></tr>`
        );
      }
      const weight = row.style === "strong" ? "font-weight:600;" : "";
      const value = row.style === "struck" ? `<s style="color:${COLOR.muted};">${escapeHtml(row.value)}</s>` : escapeHtml(row.value);
      const label = row.style === "struck" ? `color:${COLOR.muted};` : "";
      return (
        `<tr><td style="padding:4px 0;${text}${weight}${label}">${escapeHtml(row.label)}</td>` +
        `<td style="padding:4px 0 4px 12px;${text}${weight}text-align:right;white-space:nowrap;">${value}</td></tr>`
      );
    })
    .join("");
  return {
    text: totalRows(totals, savings)
      .map((row) => `${row.label}: ${row.value}`)
      .join("\n"),
    html: cell("padding:0 0 24px;", `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>`),
  };
}

/** The order rows (lines, totals) are this file's own; everything else is the shared layout's. */
function blockSection(block: Block): EmailSection {
  switch (block.kind) {
    case "heading":
      return heading(block.text);
    case "paragraph":
      return paragraph(block.text);
    case "muted":
      return muted(block.text);
    case "button":
      return button(block.label, block.url);
    case "link":
      return link(block.label, block.url);
    case "lines":
      return linesSection(block.lines);
    case "totals":
      return totalsSection(block.totals, block.savings);
    case "details":
      return details(block.title, block.rows);
    case "divider":
      return divider();
  }
}

function render(subject: string, preheader: string, blocks: Block[], footerNote: string, logoUrl: string | null): RenderedEmail {
  return renderEmail({ subject, preheader, sections: blocks.map(blockSection), footerNote, logoUrl });
}

// ---------- shared pieces ----------

function greeting(view: CustomerOrderEmailView): Block {
  return { kind: "paragraph", text: view.greetingName ? `Halo Kak ${view.greetingName},` : "Halo Kak," };
}

function orderBlocks(view: CustomerOrderEmailView): Block[] {
  return [
    { kind: "lines", lines: view.lines },
    { kind: "totals", totals: view.totals, savings: productSavings(view.lines) },
  ];
}

function addressBlock(view: CustomerOrderEmailView): Block[] {
  if (!view.address) return [];
  return [
    {
      kind: "details",
      title: "Alamat pengiriman",
      rows: [
        { label: "Penerima", value: view.address.recipientName },
        { label: "Nomor HP", value: view.address.phone },
        { label: "Alamat", value: view.address.addressText },
        ...(view.courierLabel ? [{ label: "Kurir", value: view.courierLabel }] : []),
      ],
    },
  ];
}

function accessBlocks(view: CustomerOrderEmailView, primary: boolean): Block[] {
  return [
    primary ? { kind: "button", label: "Lihat pesanan", url: view.orderUrl } : { kind: "link", label: "Lihat pesanan", url: view.orderUrl },
    ...(view.loginUrl ? [{ kind: "link" as const, label: "Masuk ke akun", url: view.loginUrl }] : []),
  ];
}

function contactLine(whatsappNumber: string | null): Block[] {
  const digits = whatsappNumber?.replace(/\D/g, "") ?? "";
  if (!digits) return [];
  return [{ kind: "muted", text: `Ada pertanyaan? Hubungi kami lewat WhatsApp di wa.me/${digits}.` }];
}

function customerFooter(view: CustomerOrderEmailView): string {
  return `Email ini dikirim karena ada pesanan dengan alamat email ini di ${view.siteHost}.`;
}

// ---------- customer emails ----------

/** `created`: right after checkout, while the order waits for payment. */
export function renderCreatedEmail(view: CreatedEmailView): RenderedEmail {
  const deadline = formatWib(view.paymentDeadline);
  const blocks: Block[] = [
    { kind: "heading", text: "Pesanan kamu sudah kami terima" },
    greeting(view),
    { kind: "paragraph", text: `Terima kasih sudah berbelanja di Ammari. Mohon selesaikan pembayaran sebelum ${deadline} supaya pesanan ${view.orderNo} bisa segera kami proses.` },
    ...(view.paymentUrl
      ? [{ kind: "button" as const, label: "Lanjutkan pembayaran", url: view.paymentUrl }]
      : [{ kind: "paragraph" as const, text: "Halaman pembayaran bisa dibuka dari halaman pesanan." }]),
    { kind: "muted", text: "Pembayaran bisa lewat QRIS, virtual account, atau e-wallet. Kalau belum dibayar sampai batas waktu, pesanan otomatis dibatalkan." },
    { kind: "divider" },
    ...orderBlocks(view),
    ...accessBlocks(view, false),
    ...contactLine(view.whatsappNumber),
  ];
  return render(`Pesanan ${view.orderNo} menunggu pembayaran`, `Selesaikan pembayaran sebelum ${deadline}.`, blocks, customerFooter(view), view.logoUrl);
}

/** `paid`: "confirmed" when the order moved to Diproses; "review" when the payment arrived but the
 * order needs a check first (stock short at payment, or paid after it was cancelled; owner decision
 * 2026-10-21: no shipping promise, staff follow up by WhatsApp). */
export function renderPaidEmail(view: CustomerOrderEmailView, variant: "confirmed" | "review"): RenderedEmail {
  const subject = `Pembayaran pesanan ${view.orderNo} sudah kami terima`;
  if (variant === "review") {
    const blocks: Block[] = [
      { kind: "heading", text: "Pembayaran sudah kami terima" },
      greeting(view),
      { kind: "paragraph", text: `Terima kasih, pembayaran ${formatRupiah(view.totals.total)} untuk pesanan ${view.orderNo} sudah kami terima.` },
      { kind: "paragraph", text: "Kami perlu mengecek pesanan ini dulu. Tim kami akan menghubungi kamu lewat WhatsApp secepatnya. Mohon maaf atas ketidaknyamanannya." },
      { kind: "divider" },
      ...orderBlocks(view),
      ...accessBlocks(view, false),
      ...contactLine(view.whatsappNumber),
    ];
    return render(subject, "Tim kami akan segera menghubungi kamu.", blocks, customerFooter(view), view.logoUrl);
  }
  const blocks: Block[] = [
    { kind: "heading", text: "Pembayaran sudah kami terima" },
    greeting(view),
    { kind: "paragraph", text: `Terima kasih, pembayaran untuk pesanan ${view.orderNo} sudah kami terima. Pesanan kamu sedang kami siapkan dengan sepenuh hati.` },
    { kind: "paragraph", text: "Nomor resi akan kami kirim lewat email setelah pesanan dikirim." },
    ...accessBlocks(view, true),
    { kind: "divider" },
    ...orderBlocks(view),
    ...addressBlock(view),
    ...contactLine(view.whatsappNumber),
  ];
  return render(subject, "Pesanan kamu sedang kami siapkan.", blocks, customerFooter(view), view.logoUrl);
}

/** `cancelled`: the payment window ended (gateway expiry or the sweep), the payment was cancelled at
 * the gateway, or staff cancelled the order (session 16, owner decision 45: no reason named; a paid
 * order is refunded in full, ongkir included, and staff follow up by WhatsApp). */
export function renderCancelledEmail(view: CancelledEmailView): RenderedEmail {
  const voucherBlocks: Block[] = view.totals.discount > 0 ? [{ kind: "paragraph", text: "Voucher yang kamu pakai sudah kembali ke akunmu dan bisa dipakai lagi selama masa berlakunya." }] : [];
  if (view.reason === "admin_paid") {
    const blocks: Block[] = [
      { kind: "heading", text: "Pesanan dibatalkan" },
      greeting(view),
      {
        kind: "paragraph",
        text: `Pesanan ${view.orderNo} kami batalkan. Dana ${formatRupiah(view.totals.total)} (termasuk ongkir) akan kami kembalikan penuh. Tim kami akan menghubungi kamu lewat WhatsApp untuk proses pengembaliannya. Mohon maaf atas ketidaknyamanannya.`,
      },
      ...voucherBlocks,
      ...accessBlocks(view, false),
      { kind: "divider" },
      ...orderBlocks(view),
      ...contactLine(view.whatsappNumber),
    ];
    return render(`Pesanan ${view.orderNo} dibatalkan`, "Dana pesanan ini akan kami kembalikan penuh.", blocks, customerFooter(view), view.logoUrl);
  }
  const why =
    view.reason === "admin_unpaid"
      ? ""
      : view.reason === "payment_expired"
        ? view.paymentDeadline
          ? ` karena pembayarannya belum kami terima sampai batas waktu ${formatWib(view.paymentDeadline)}`
          : " karena pembayarannya belum kami terima sampai batas waktu"
        : " karena pembayarannya dibatalkan";
  const blocks: Block[] = [
    { kind: "heading", text: "Pesanan dibatalkan" },
    greeting(view),
    { kind: "paragraph", text: `Pesanan ${view.orderNo} kami batalkan${why}. Tidak ada dana yang ditarik untuk pesanan ini.` },
    ...voucherBlocks,
    { kind: "paragraph", text: "Kalau masih ingin memesan, tekan Pesan lagi: barang dari pesanan ini kami masukkan lagi ke keranjangmu, selama stoknya masih ada." },
    // The order page (the "Lihat pesanan" link) has the "Pesan lagi" button (plan §9.1, session 15).
    { kind: "button", label: "Pesan lagi", url: view.orderUrl },
    { kind: "divider" },
    ...orderBlocks(view),
    ...contactLine(view.whatsappNumber),
  ];
  const preheader = view.reason === "admin_unpaid" ? "Tidak ada dana yang ditarik untuk pesanan ini." : "Pembayaran belum kami terima sampai batas waktu.";
  return render(`Pesanan ${view.orderNo} dibatalkan`, preheader, blocks, customerFooter(view), view.logoUrl);
}

/** `shipped`: staff marked the order sent ("Tandai dikirim"; Phase K: the courier picked it up). */
export function renderShippedEmail(view: ShippedEmailView): RenderedEmail {
  const courier = view.courier ?? view.courierLabel;
  const blocks: Block[] = [
    { kind: "heading", text: "Pesanan kamu sudah dikirim" },
    greeting(view),
    { kind: "paragraph", text: `Kabar baik, pesanan ${view.orderNo} sudah kami kirim. Semoga cepat sampai dan kamu suka.` },
    ...(courier || view.trackingNumber
      ? [
          {
            kind: "details" as const,
            title: "Pengiriman",
            rows: [...(courier ? [{ label: "Kurir", value: courier }] : []), ...(view.trackingNumber ? [{ label: "Nomor resi", value: view.trackingNumber }] : [])],
          },
        ]
      : []),
    ...accessBlocks(view, true),
    { kind: "divider" },
    ...orderBlocks(view),
    ...addressBlock({ ...view, courierLabel: null }),
    ...contactLine(view.whatsappNumber),
  ];
  return render(`Pesanan ${view.orderNo} sudah dikirim`, view.trackingNumber ? `Nomor resi: ${view.trackingNumber}` : "Pesanan kamu sedang dalam perjalanan.", blocks, customerFooter(view), view.logoUrl);
}

/** `delivered` (Phase K3): the courier reported the parcel delivered and the order is complete. */
export function renderDeliveredEmail(view: DeliveredEmailView): RenderedEmail {
  const blocks: Block[] = [
    { kind: "heading", text: "Pesanan sudah sampai" },
    greeting(view),
    { kind: "paragraph", text: `Menurut kurir, pesanan ${view.orderNo} sudah diterima. Terima kasih sudah berbelanja di Ammari, semoga kamu suka dan nyaman memakainya.` },
    {
      kind: "paragraph",
      text: "Kalau ada yang kurang pas, misalnya ukuran, kamu bisa mengajukan penukaran atau pengembalian sesuai ketentuan kami. Kalau paketnya ternyata belum kamu terima, segera hubungi kami.",
    },
    { kind: "link", label: "Ketentuan pengembalian dan penukaran", url: view.returnsUrl },
    ...accessBlocks(view, true),
    { kind: "divider" },
    ...orderBlocks(view),
    ...contactLine(view.whatsappNumber),
  ];
  return render(`Pesanan ${view.orderNo} sudah sampai`, "Semoga kamu suka dengan pesananmu.", blocks, customerFooter(view), view.logoUrl);
}

// ---------- owner email ----------

/** `owner_paid` (decision 11): every paid web order, to store_settings.support_email. */
export function renderOwnerPaidEmail(view: OwnerPaidEmailView): RenderedEmail {
  const head = {
    paid: { subject: `Pesanan baru dibayar: ${view.orderNo}`, heading: "Pesanan baru sudah dibayar", note: "Pesanan sudah masuk antrean Diproses. Pesan kurir sesuai layanan di bawah." },
    stock_short: {
      subject: `Perlu dicek: ${view.orderNo} dibayar, stok kurang`,
      heading: "Dibayar, tapi stok kurang",
      note: "Pembayaran sudah diterima, tapi stok fisik tidak cukup saat pembayaran masuk. Pesanan masih Menunggu pembayaran dan ditandai Perlu dicek. Tambah stok lalu proses, atau kembalikan dana. Pembeli sudah diberi tahu bahwa tim akan menghubungi lewat WhatsApp.",
    },
    after_cancel: {
      subject: `Perlu dicek: ${view.orderNo} dibayar setelah dibatalkan`,
      heading: "Dibayar setelah pesanan dibatalkan",
      note: "Pembayaran masuk setelah pesanan dibatalkan, jadi tidak ada barang yang terjual. Dana perlu dikembalikan ke pembeli. Pembeli sudah diberi tahu bahwa tim akan menghubungi lewat WhatsApp.",
    },
  }[view.variant];
  const buyerRows = [
    ...(view.buyer.name ? [{ label: "Nama", value: view.buyer.name }] : []),
    ...(view.buyer.email ? [{ label: "Email", value: view.buyer.email }] : []),
    ...(view.buyer.phone ? [{ label: "WhatsApp", value: view.buyer.phone }] : []),
  ];
  const blocks: Block[] = [
    { kind: "heading", text: head.heading },
    { kind: "paragraph", text: `Pesanan ${view.orderNo}, total ${formatRupiah(view.totals.total)}${view.paidAt ? `, dibayar ${formatWib(view.paidAt)}` : ""}.` },
    { kind: "paragraph", text: head.note },
    ...(view.adminOrderUrl ? [{ kind: "button" as const, label: "Buka di admin", url: view.adminOrderUrl }] : []),
    { kind: "divider" },
    { kind: "lines", lines: view.lines },
    { kind: "totals", totals: view.totals, savings: productSavings(view.lines) },
    ...(buyerRows.length > 0 ? [{ kind: "details" as const, title: "Pembeli", rows: buyerRows }] : []),
    ...(view.address
      ? [
          {
            kind: "details" as const,
            title: "Kirim ke",
            rows: [
              { label: "Penerima", value: view.address.recipientName },
              { label: "Nomor HP", value: view.address.phone },
              { label: "Alamat", value: view.address.addressText },
              ...(view.courierLabel ? [{ label: "Layanan", value: view.courierLabel }] : []),
            ],
          },
        ]
      : []),
  ];
  return render(head.subject, head.heading, blocks, "Email ini untuk admin Ammari dan berisi data pembeli. Jangan diteruskan.", view.logoUrl);
}
