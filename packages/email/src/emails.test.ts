import { describe, expect, test } from "vitest";
import { EMAIL_CONTACT, emailLogoUrl } from "./brand";
import { button, link, paragraph, renderEmail, type RenderedEmail } from "./layout";
import { renderSignInCodeEmail } from "./sign-in-code";
import { renderStaffInviteEmail, staffInviteLoginLink } from "./staff-invite";

// docs/plans/email-design.md: structure every Ammari email must keep.

const LOGO = "https://ammari.example/logos/ammari-primary.png";
// 14.35 WIB on 27 October 2026.
const EXPIRES = new Date("2026-10-27T07:35:00Z");

/** The hidden preview line, without the zero-width filler after it. */
function preheaderOf(html: string): string {
  const match = html.match(/<div style="display:none;[^"]*">([^<&]*)/);
  if (!match) throw new Error("no preheader");
  return match[1]!;
}

function expectAmmariLayout(email: RenderedEmail) {
  expect(email.html.startsWith("<!doctype html>")).toBe(true);
  expect(email.html).toContain(`<title>${email.subject}</title>`);
  expect(email.html).toContain("max-width:600px");
  expect(email.html).toContain('name="color-scheme" content="light dark"');
  expect(email.html).toContain("@media (prefers-color-scheme:dark)");
  // Footer contact, in both parts.
  for (const part of [email.text, email.html]) {
    expect(part).toContain(EMAIL_CONTACT.email);
    expect(part).toContain(EMAIL_CONTACT.whatsapp);
  }
  // No em or en dash anywhere.
  for (const part of [email.subject, email.text, email.html]) expect(part).not.toMatch(/[—–]/);
  // Images only from absolute https URLs.
  for (const [, src] of email.html.matchAll(/<img[^>]*\ssrc="([^"]*)"/g)) expect(src).toMatch(/^https:\/\//);
  // Colours exactly as brand.ts writes them (upper-case hex): the dark-mode CSS matches on that text.
  expect(email.html).not.toMatch(/color:#[0-9A-F]*[a-f][0-9a-fA-F]*/);
  expect(email.text.trim().length).toBeGreaterThan(0);
  expect(email.text).not.toMatch(/<\/?(?:table|tr|td|a|br|div|p|span|img|s)\b/i);
}

describe("renderSignInCodeEmail", () => {
  for (const audience of ["customer", "staff"] as const) {
    describe(audience, () => {
      const email = renderSignInCodeEmail({ audience, code: "482915", expiresAt: EXPIRES, validMinutes: 5, logoUrl: LOGO });

      test("is an Ammari email with a preheader and a plain-text part", () => {
        expectAmmariLayout(email);
        expect(preheaderOf(email.html)).toBe("Kode ini berlaku 5 menit, sampai pukul 14.35 WIB. Jangan bagikan ke siapa pun.");
        expect(email.html).toContain(`src="${LOGO}"`);
      });

      test("names the purpose in the subject but never the code", () => {
        expect(email.subject).toBe(audience === "customer" ? "Kode masuk Ammari" : "Kode masuk Ammari Admin");
        expect(email.subject).not.toContain("482915");
        expect(preheaderOf(email.html)).not.toContain("482915");
      });

      test("shows the code as one large text node, in both parts", () => {
        expect(email.html).toMatch(/<td align="center" style="[^"]*font-size:34px;[^"]*user-select:all;">482915<\/td>/);
        expect(email.text).toMatch(/^482915$/m);
      });

      test("states the expiry and the safety line", () => {
        for (const part of [email.text, email.html]) {
          expect(part).toContain("Berlaku 5 menit, sampai pukul 14.35 WIB.");
          expect(part).toContain("abaikan saja email ini");
          expect(part).toContain("Jangan bagikan kode ini ke siapa pun");
        }
      });

      test("has no link at all", () => {
        expect(email.html).not.toMatch(/<a\s/i);
        expect(email.html).not.toContain("href=");
        expect(email.text).not.toMatch(/https?:\/\//);
      });
    });
  }

  test("escapes what it is given", () => {
    const email = renderSignInCodeEmail({ audience: "customer", code: "<b>1</b>", expiresAt: EXPIRES, validMinutes: 5, logoUrl: null });
    expect(email.html).toContain("&lt;b&gt;1&lt;/b&gt;");
    expect(email.html).not.toContain("<b>1</b>");
  });
});

describe("renderStaffInviteEmail", () => {
  const email = renderStaffInviteEmail({
    to: "rina@example.test",
    name: "Rina",
    roleName: "Admin Gudang",
    loginUrl: "https://admin.ammari.example",
    inviteExpiresAt: new Date("2026-11-03T07:30:00Z"),
    logoUrl: LOGO,
  });

  test("is an Ammari email with a preheader and a plain-text part", () => {
    expectAmmariLayout(email);
    expect(email.subject).toBe("Undangan ke Admin Ammari");
    expect(preheaderOf(email.html)).toBe("Masuk dengan rina@example.test sebelum 3 November 2026, 14.30 WIB.");
  });

  test("has one button to the admin site and says which email to use and until when", () => {
    expect(email.html.match(/<a\s/g)).toHaveLength(1);
    expect(email.html).toContain('<a href="https://admin.ammari.example/login?email=rina%40example.test"');
    expect(email.html).toContain(">Buka Admin Ammari</a>");
    for (const part of [email.text, email.html]) {
      expect(part).toContain("Admin Gudang");
      expect(part).toContain("rina@example.test");
      expect(part).toContain("3 November 2026, 14.30 WIB");
      expect(part).toContain("Kalau Anda tidak merasa diundang, abaikan email ini.");
    }
    expect(email.text).toContain("Buka Admin Ammari:\nhttps://admin.ammari.example/login?email=rina%40example.test");
  });

  test("encodes the address and tolerates a trailing slash on the origin", () => {
    expect(staffInviteLoginLink("https://admin.ammari.example/", "a+b@example.test")).toBe(
      "https://admin.ammari.example/login?email=a%2Bb%40example.test",
    );
  });

  test("carries no token or code", () => {
    expect(email.html).not.toMatch(/token=|[?&]t=/);
  });
});

describe("renderEmail", () => {
  test("refuses a link that is not a web address", () => {
    expect(() => button("Buka", "javascript:alert(1)")).toThrow();
    expect(() => link("Buka", "/relatif")).toThrow();
    expect(button("Buka", "http://localhost:3001").html).toContain('href="http://localhost:3001"');
  });

  test("without a logo URL shows the text wordmark only", () => {
    const email = renderEmail({ subject: "Tes", preheader: "Tes", sections: [paragraph("Isi")], footerNote: "Catatan", logoUrl: null });
    expect(email.html).not.toContain("<img");
    expect(email.html).toContain(">AMMARI</td>");
  });

  test("puts the footer note after the contact lines in the plain text", () => {
    const email = renderEmail({ subject: "Tes", preheader: "Tes", sections: [paragraph("Isi")], footerNote: "Catatan", logoUrl: null });
    expect(email.text).toBe(`Isi\n\nAmmari, gamis syar'i dari Bandung\nEmail: ${EMAIL_CONTACT.email}\nWhatsApp: ${EMAIL_CONTACT.whatsapp}\n\nCatatan\n`);
  });
});

describe("emailLogoUrl", () => {
  test("only an https origin gives a logo URL", () => {
    expect(emailLogoUrl("https://ammari.example")).toBe(LOGO);
    expect(emailLogoUrl("http://localhost:3000")).toBeNull();
    expect(emailLogoUrl(undefined)).toBeNull();
    expect(emailLogoUrl("")).toBeNull();
  });
});
