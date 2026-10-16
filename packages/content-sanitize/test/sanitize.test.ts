import { describe, expect, test } from "vitest";
import {
  ContentTooLargeError,
  MAX_INFO_PAGE_HTML_LENGTH,
  MAX_STOREFRONT_DESCRIPTION_HTML_LENGTH,
  sanitizeInfoPageHtml,
  sanitizeStorefrontDescriptionHtml,
} from "../src/index";

describe("sanitizeStorefrontDescriptionHtml — allowed shapes pass through unchanged", () => {
  test("paragraphs, bold, italic survive", () => {
    const html = "<p>Gamis <strong>syar'i</strong> dengan bahan <em>adem</em> dan nyaman.</p>";
    expect(sanitizeStorefrontDescriptionHtml(html)).toBe(html);
  });

  test("bulleted and numbered lists, including nested lists, survive", () => {
    const html = "<ul><li>Lingkar dada lega</li><li>Bahan tidak menerawang<ol><li>Dobel layer</li></ol></li></ul>";
    expect(sanitizeStorefrontDescriptionHtml(html)).toBe(html);
  });

  test("br survives", () => {
    // sanitize-html renders a void element as self-closing ("<br />"), not bare "<br>" — both
    // parse identically in a browser, so this is a formatting detail, not a correctness one.
    const out = sanitizeStorefrontDescriptionHtml("<p>Baris satu<br>Baris dua</p>");
    expect(out).toBe("<p>Baris satu<br />Baris dua</p>");
  });

  test("empty string is allowed (no description yet)", () => {
    expect(sanitizeStorefrontDescriptionHtml("")).toBe("");
  });
});

describe("sanitizeStorefrontDescriptionHtml — malicious / disallowed payloads are neutralized", () => {
  test("script tags are removed entirely, including their contents", () => {
    const out = sanitizeStorefrontDescriptionHtml("<p>Halo</p><script>alert('xss')</script>");
    expect(out).not.toMatch(/script/i);
    expect(out).not.toMatch(/alert/);
    expect(out).toBe("<p>Halo</p>");
  });

  test("event handler attributes are stripped from an otherwise-allowed tag", () => {
    const out = sanitizeStorefrontDescriptionHtml('<p onclick="alert(1)" onmouseover="evil()">Teks</p>');
    expect(out).toBe("<p>Teks</p>");
  });

  test("javascript: URLs never survive — the <a> tag itself is unwrapped (links aren't allowed)", () => {
    const out = sanitizeStorefrontDescriptionHtml('<p><a href="javascript:alert(1)">Klik</a></p>');
    expect(out).toBe("<p>Klik</p>");
    expect(out).not.toMatch(/javascript:/i);
    expect(out).not.toMatch(/href/i);
  });

  test("data: URLs never survive either", () => {
    const out = sanitizeStorefrontDescriptionHtml('<p><a href="data:text/html,<script>alert(1)</script>">x</a></p>');
    expect(out).not.toMatch(/data:/i);
    expect(out).not.toMatch(/<script/i);
  });

  test("img tags (and their onerror payload) are stripped — no images allowed in this editor", () => {
    const out = sanitizeStorefrontDescriptionHtml('<p>Lihat <img src="x" onerror="alert(1)">ini</p>');
    expect(out).not.toMatch(/<img/i);
    expect(out).not.toMatch(/onerror/i);
    expect(out).toBe("<p>Lihat ini</p>");
  });

  test("svg/onload payload is neutralized", () => {
    const out = sanitizeStorefrontDescriptionHtml('<svg onload="alert(1)"><circle/></svg>');
    expect(out).not.toMatch(/onload/i);
    expect(out).not.toMatch(/<svg/i);
  });

  test("iframe with a javascript: src is stripped entirely", () => {
    const out = sanitizeStorefrontDescriptionHtml('<iframe src="javascript:alert(1)"></iframe>');
    expect(out).not.toMatch(/iframe/i);
    expect(out).not.toMatch(/javascript:/i);
  });

  test("inline style and class attributes are stripped from an allowed tag", () => {
    const out = sanitizeStorefrontDescriptionHtml('<p class="evil" style="position:fixed">Teks</p>');
    expect(out).toBe("<p>Teks</p>");
  });

  test("an unknown/disallowed node type (heading) is unwrapped, keeping only its text", () => {
    const out = sanitizeStorefrontDescriptionHtml("<h1>Judul Besar</h1><p>Isi</p>");
    expect(out).toBe("Judul Besar<p>Isi</p>");
  });

  test("an unknown/disallowed mark type (strike-through, code) is unwrapped, keeping only its text", () => {
    const out = sanitizeStorefrontDescriptionHtml("<p><s>dicoret</s> dan <code>kode</code></p>");
    expect(out).toBe("<p>dicoret dan kode</p>");
  });

  test("a blockquote and horizontal rule are discarded/unwrapped, not rendered as-is", () => {
    const out = sanitizeStorefrontDescriptionHtml("<blockquote>Kutipan</blockquote><hr><p>Teks</p>");
    expect(out).not.toMatch(/<blockquote/i);
    expect(out).not.toMatch(/<hr/i);
    expect(out).toContain("Kutipan");
  });

  test("a style tag's contents are removed, not just unwrapped", () => {
    const out = sanitizeStorefrontDescriptionHtml("<style>body{display:none}</style><p>Teks</p>");
    expect(out).toBe("<p>Teks</p>");
  });

  test("an HTML comment hiding a conditional/IE-style payload is dropped", () => {
    const out = sanitizeStorefrontDescriptionHtml("<p>Teks</p><!--[if gte IE 4]><script>alert(1)</script><![endif]-->");
    expect(out).not.toMatch(/alert/);
    expect(out).not.toMatch(/<!--/);
  });

  test("case-mangled / malformed tags attempting to dodge the allowlist are still neutralized", () => {
    const out = sanitizeStorefrontDescriptionHtml('<ScRiPt>alert(1)</ScRiPt><p>Teks</p>');
    expect(out).not.toMatch(/alert/);
    expect(out).toBe("<p>Teks</p>");
  });
});

describe("sanitizeStorefrontDescriptionHtml — oversized documents", () => {
  test("input at or under the max length is accepted", () => {
    const html = `<p>${"a".repeat(MAX_STOREFRONT_DESCRIPTION_HTML_LENGTH - 7)}</p>`; // "<p>" + "</p>" = 7 chars
    expect(html.length).toBe(MAX_STOREFRONT_DESCRIPTION_HTML_LENGTH);
    expect(() => sanitizeStorefrontDescriptionHtml(html)).not.toThrow();
  });

  test("input over the max length is rejected with ContentTooLargeError, not silently truncated", () => {
    const html = `<p>${"a".repeat(MAX_STOREFRONT_DESCRIPTION_HTML_LENGTH)}</p>`;
    expect(() => sanitizeStorefrontDescriptionHtml(html)).toThrow(ContentTooLargeError);
  });

  test("an oversized payload is rejected even when most of it would have been stripped anyway", () => {
    const html = `${"<script>alert(1)</script>".repeat(2000)}<p>Teks</p>`;
    expect(html.length).toBeGreaterThan(MAX_STOREFRONT_DESCRIPTION_HTML_LENGTH);
    expect(() => sanitizeStorefrontDescriptionHtml(html)).toThrow(ContentTooLargeError);
  });
});

describe("sanitizeInfoPageHtml — same allowlist as the storefront description, plus h2", () => {
  test("h2 survives, unlike sanitizeStorefrontDescriptionHtml", () => {
    const html = "<h2>Ketentuan Umum</h2><p>Isi pasal.</p>";
    expect(sanitizeInfoPageHtml(html)).toBe(html);
    expect(sanitizeStorefrontDescriptionHtml(html)).toBe("Ketentuan Umum<p>Isi pasal.</p>");
  });

  test("h3 is still unwrapped — only h2 was added to the allowlist", () => {
    const out = sanitizeInfoPageHtml("<h3>Sub-bagian</h3><p>Isi</p>");
    expect(out).toBe("Sub-bagian<p>Isi</p>");
  });

  test("every storefront-description shape still survives (paragraphs, bold, italic, lists, br)", () => {
    const html = "<h2>Bagian 1</h2><p>Gamis <strong>syar'i</strong> dengan bahan <em>adem</em>.</p><ul><li>Poin satu</li></ul><p>Baris satu<br />Baris dua</p>";
    expect(sanitizeInfoPageHtml(html)).toBe(html);
  });

  test("an h2 with an event-handler attribute is neutralized the same way a <p> is", () => {
    const out = sanitizeInfoPageHtml('<h2 onclick="alert(1)">Judul</h2>');
    expect(out).toBe("<h2>Judul</h2>");
  });

  test("links are still declined — an <a> tag is unwrapped, not rendered", () => {
    const out = sanitizeInfoPageHtml('<h2>Judul</h2><p><a href="javascript:alert(1)">Klik</a></p>');
    expect(out).toBe("<h2>Judul</h2><p>Klik</p>");
  });

  test("script tags are removed entirely, including their contents", () => {
    const out = sanitizeInfoPageHtml("<h2>Judul</h2><script>alert('xss')</script>");
    expect(out).toBe("<h2>Judul</h2>");
  });

  test("uses its own, much larger length cap than the storefront description", () => {
    expect(MAX_INFO_PAGE_HTML_LENGTH).toBeGreaterThan(MAX_STOREFRONT_DESCRIPTION_HTML_LENGTH);
    const html = `<p>${"a".repeat(MAX_INFO_PAGE_HTML_LENGTH - 7)}</p>`;
    expect(() => sanitizeInfoPageHtml(html)).not.toThrow();
  });

  test("an info page over its own (larger) max length is still rejected, not silently truncated", () => {
    const html = `<p>${"a".repeat(MAX_INFO_PAGE_HTML_LENGTH)}</p>`;
    expect(() => sanitizeInfoPageHtml(html)).toThrow(ContentTooLargeError);
  });
});
