import { EMAIL_COLOR as COLOR, EMAIL_CONTACT, EMAIL_FONT as FONT, EMAIL_MONO_FONT, EMAIL_SERIF_FONT } from "./brand";
import { escapeHtml } from "./format";

// The one layout every Ammari email uses (docs/plans/email-design.md §2): order emails
// (@ammari/commerce), sign-in codes (@ammari/auth) and the staff invite (apps/admin). Pure: the
// same input always renders the same bytes, which order emails rely on (a retried send must be
// identical for the provider's idempotency key).
//
// Built for the clients the buyers and staff actually use (Gmail web and app, Apple Mail, Outlook):
// table layout, inline styles only (Gmail drops most <style> rules), one column at most 600px wide
// that shrinks on phones, a ghost table for Outlook on Windows (which ignores max-width), and a
// plain-text part with the same content. The <style> block is progressive enhancement only: dark
// mode for Apple Mail / iOS Mail / Outlook for Mac, and a font fallback for Outlook on Windows.

/** One piece of an email: its plain-text form and its HTML rows (`<tr>`s in the content table). */
export interface EmailSection {
  text: string;
  html: string;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export interface EmailLayoutInput {
  subject: string;
  /** The inbox preview line next to the subject; hidden in the body. */
  preheader: string;
  sections: EmailSection[];
  /** Why the reader got this email, at the foot under the contact lines. */
  footerNote: string;
  /** The logo mark next to "AMMARI": an absolute https URL (brand.ts `emailLogoUrl`), or null for
   * the text wordmark only. */
  logoUrl: string | null;
}

const BODY_TEXT = `font-family:${FONT};font-size:15px;line-height:1.6;color:${COLOR.text};`;

const row = (style: string, content: string) => `<tr><td style="${style}">${content}</td></tr>`;

// ---------- sections ----------

/** Links in emails are only ever web addresses: refuses anything else (javascript:, data:, a
 * relative path) rather than writing it into an href. */
function webUrl(url: string): string {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    throw new Error("email link is not an absolute URL");
  }
  if (protocol !== "https:" && protocol !== "http:") throw new Error(`email link has a non-web scheme (${protocol})`);
  return url;
}

export function heading(text: string): EmailSection {
  return { text, html: row(`padding:0 0 12px;font-family:${FONT};font-size:20px;line-height:1.4;font-weight:600;color:${COLOR.text};`, escapeHtml(text)) };
}

export function paragraph(text: string): EmailSection {
  return { text, html: row(`padding:0 0 16px;${BODY_TEXT}`, escapeHtml(text)) };
}

/** Secondary text: smaller and muted. */
export function muted(text: string): EmailSection {
  return { text, html: row(`padding:0 0 16px;font-family:${FONT};font-size:13px;line-height:1.6;color:${COLOR.muted};`, escapeHtml(text)) };
}

/** The one main action. The colour sits on the cell as well as the link, so Outlook on Windows
 * (which ignores padding on links) still shows a filled button. */
export function button(label: string, url: string): EmailSection {
  const href = escapeHtml(webUrl(url));
  return {
    text: `${label}:\n${url}`,
    html: row(
      "padding:4px 0 24px;",
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${COLOR.brand}" style="background-color:${COLOR.brand};border-radius:4px;">` +
        `<a href="${href}" style="display:inline-block;padding:14px 28px;background-color:${COLOR.brand};color:${COLOR.white};font-family:${FONT};font-size:15px;font-weight:600;line-height:1.2;text-decoration:none;border-radius:4px;">${escapeHtml(label)}</a>` +
        `</td></tr></table>`,
    ),
  };
}

export function link(label: string, url: string): EmailSection {
  return { text: `${label}:\n${url}`, html: row(`padding:0 0 16px;${BODY_TEXT}`, `<a href="${escapeHtml(webUrl(url))}" style="color:${COLOR.brand};text-decoration:underline;">${escapeHtml(label)}</a>`) };
}

export function divider(): EmailSection {
  return { text: "----", html: row("padding:8px 0 24px;", `<div style="border-top:1px solid ${COLOR.line};font-size:0;line-height:0;">&nbsp;</div>`) };
}

/** A titled list of label/value pairs (an address, a shipment, a login email). */
export function details(title: string, rows: { label: string; value: string }[]): EmailSection {
  const rowsHtml = rows
    .map(
      (item) =>
        `<tr><td style="padding:2px 12px 2px 0;font-family:${FONT};font-size:14px;line-height:1.5;color:${COLOR.muted};vertical-align:top;white-space:nowrap;">${escapeHtml(item.label)}</td>` +
        `<td style="padding:2px 0;font-family:${FONT};font-size:14px;line-height:1.5;color:${COLOR.text};word-break:break-word;">${escapeHtml(item.value)}</td></tr>`,
    )
    .join("");
  return {
    text: [title, ...rows.map((item) => `${item.label}: ${item.value}`)].join("\n"),
    html: row(
      "padding:0 0 20px;",
      `<p style="margin:0 0 6px;font-family:${FONT};font-size:14px;font-weight:600;color:${COLOR.text};">${escapeHtml(title)}</p><table role="presentation" cellpadding="0" cellspacing="0" border="0">${rowsHtml}</table>`,
    ),
  };
}

/** A one-time code: large, high-contrast TEXT (never an image), one text node so a tap or a
 * double-click selects exactly the code (letter-spacing adds no characters when copied). */
export function code(value: string): EmailSection {
  // The trailing letter-spacing after the last digit is balanced by the same extra left padding.
  const style =
    `padding:18px 12px 18px 22px;background-color:${COLOR.highlight};border:1px solid ${COLOR.line};border-radius:6px;` +
    `font-family:${EMAIL_MONO_FONT};font-size:34px;line-height:1.2;font-weight:700;letter-spacing:10px;color:${COLOR.text};` +
    "-webkit-user-select:all;user-select:all;";
  return {
    text: value,
    html: row("padding:4px 0 20px;", `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="${style}">${escapeHtml(value)}</td></tr></table>`),
  };
}

// ---------- the page ----------

const BRAND_LINE = "Ammari, gamis syar'i dari Bandung";
const CONTACT_LINES = [`Email: ${EMAIL_CONTACT.email}`, `WhatsApp: ${EMAIL_CONTACT.whatsapp}`];

// Dark counterparts of brand.ts's colours. Matched on the inline style text itself (exact
// `color:#XXXXXX`, no space, upper-case hex as in brand.ts; a client that re-serializes styles
// simply keeps the light design), so every
// section (including @ammari/commerce's own order rows) follows without extra classes. Clients
// that do not support this (Gmail) keep the light design or apply their own inversion, which the
// design survives: no text in images, a transparent logo, a code box with its own border.
const DARK = { page: "#151212", card: "#201C1C", highlight: "#2C2626", text: "#F3EFEF", muted: "#BDB2B2", brand: "#D9CACA", line: "#3D3535" };
const HEAD_STYLE =
  "<style>" +
  ":root{color-scheme:light dark;supported-color-schemes:light dark;}" +
  "a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important;font-size:inherit!important;font-family:inherit!important;font-weight:inherit!important;line-height:inherit!important;}" +
  "@media (prefers-color-scheme:dark){" +
  `[style*="background-color:${COLOR.page}"]{background-color:${DARK.page}!important;}` +
  `[style*="background-color:${COLOR.white}"]{background-color:${DARK.card}!important;}` +
  `[style*="background-color:${COLOR.highlight}"]{background-color:${DARK.highlight}!important;}` +
  `[style*="color:${COLOR.text}"]{color:${DARK.text}!important;}` +
  `[style*="color:${COLOR.muted}"]{color:${DARK.muted}!important;}` +
  `[style*="color:${COLOR.brand}"]:not([style*="background-color:${COLOR.brand}"]){color:${DARK.brand}!important;}` +
  `[style*="${COLOR.line}"]{border-color:${DARK.line}!important;}` +
  // The mark is gray red on transparent: a light tile keeps it visible on the dark card.
  `.am-logo img{background-color:${COLOR.page}!important;border-radius:4px;}` +
  "}" +
  "</style>" +
  // Outlook on Windows: a font it lacks would otherwise fall back to Times New Roman.
  `<!--[if mso]><style>td,p,a,span,div{font-family:Arial,Helvetica,sans-serif!important;}.am-serif{font-family:Georgia,serif!important;}</style><![endif]-->`;

/** "AMMARI" in the header, with the logo mark to its left when there is a public URL for it (the
 * storefront's `/logos/ammari-primary.png`, 94x112, shown 24x28). */
function headerHtml(logoUrl: string | null): string {
  const wordmark = `font-family:${EMAIL_SERIF_FONT};font-size:22px;line-height:1;letter-spacing:5px;font-weight:600;color:${COLOR.brand};`;
  if (!logoUrl) return `<tr><td class="am-serif" style="padding:28px 24px 8px;${wordmark}">AMMARI</td></tr>`;
  return (
    `<tr><td style="padding:28px 24px 8px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td class="am-logo" style="padding:0 10px 0 0;vertical-align:middle;"><img src="${escapeHtml(logoUrl)}" width="24" height="28" alt="Ammari" style="display:block;width:24px;height:28px;border:0;outline:none;text-decoration:none;"></td>` +
    `<td class="am-serif" style="vertical-align:middle;${wordmark}">AMMARI</td>` +
    `</tr></table></td></tr>`
  );
}

function footerHtml(note: string): string {
  const small = `font-family:${FONT};font-size:12px;line-height:1.6;color:${COLOR.muted};`;
  return (
    `<tr><td style="padding:16px 24px 28px;border-top:1px solid ${COLOR.line};${small}">` +
    `<span style="font-weight:600;color:${COLOR.brand};">${escapeHtml(BRAND_LINE)}</span><br>` +
    `${CONTACT_LINES.map(escapeHtml).join("<br>")}` +
    `<br><br>${escapeHtml(note).replace(/\n/g, "<br>")}` +
    `</td></tr>`
  );
}

/** Zero-width filler after the preheader, so clients do not pull body text into the preview. */
const PREHEADER_FILLER = "&#847;&zwnj;&nbsp;".repeat(40);

export function renderEmail(input: EmailLayoutInput): RenderedEmail {
  const footerText = [BRAND_LINE, ...CONTACT_LINES, "", input.footerNote].join("\n");
  const text = [...input.sections.map((section) => section.text), "", footerText].join("\n\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
  const html =
    `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">` +
    // Stops iOS turning the code, the phone number or a date into a link.
    `<meta name="format-detection" content="telephone=no,date=no,address=no,email=no">` +
    `<title>${escapeHtml(input.subject)}</title>${HEAD_STYLE}</head>` +
    `<body style="margin:0;padding:0;background-color:${COLOR.page};">` +
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">${escapeHtml(input.preheader)}${PREHEADER_FILLER}</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${COLOR.page};"><tr><td align="center" style="padding:24px 12px;">` +
    `<!--[if mso]><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background-color:${COLOR.white};border-radius:6px;border-top:4px solid ${COLOR.brand};">` +
    headerHtml(input.logoUrl) +
    `<tr><td style="padding:16px 24px 8px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${input.sections.map((section) => section.html).join("")}</table></td></tr>` +
    footerHtml(input.footerNote) +
    `</table>` +
    `<!--[if mso]></td></tr></table><![endif]-->` +
    `</td></tr></table></body></html>`;
  return { subject: input.subject, text, html };
}
