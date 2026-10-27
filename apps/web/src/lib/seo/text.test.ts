import { describe, expect, test } from "vitest";
import { htmlToPlainText, truncateAtWord } from "./text";

describe("htmlToPlainText", () => {
  test("turns block tags into spaces so words never glue together", () => {
    expect(htmlToPlainText("<p>Bahan premium</p><p>Nyaman</p><ul><li>Satu</li><li>Dua</li></ul>")).toBe("Bahan premium Nyaman Satu Dua");
  });

  test("decodes entities and collapses whitespace, nbsp included", () => {
    expect(htmlToPlainText("<p>Gamis&nbsp;&amp; Khimar &quot;Syar&#39;i&quot;&#x21;</p>\n\n<br>  baru")).toBe('Gamis & Khimar "Syar\'i"! baru');
  });

  test("leaves an unknown or out-of-range entity as it was", () => {
    expect(htmlToPlainText("a &foo; b &#99999999; c &#xD800;")).toBe("a &foo; b &#99999999; c &#xD800;");
  });

  test("markup only gives an empty string", () => {
    expect(htmlToPlainText("<p> </p><p><br></p>")).toBe("");
  });
});

describe("truncateAtWord", () => {
  test("keeps short text as is", () => {
    expect(truncateAtWord("Gamis syar'i  nyaman", 160)).toBe("Gamis syar'i nyaman");
  });

  test("cuts at the last word boundary, adds an ellipsis, and stays within the limit", () => {
    const text = "Gamis syar'i berbahan katun rayon premium, jatuh dan adem, cocok dipakai seharian untuk kegiatan apa saja.";
    const result = truncateAtWord(text, 40);
    expect(result.length).toBeLessThanOrEqual(40);
    expect(result).toBe("Gamis syar'i berbahan katun rayon…");
  });

  test("drops trailing punctuation before the ellipsis", () => {
    expect(truncateAtWord("Satu dua tiga, empat lima enam tujuh", 16)).toBe("Satu dua tiga…");
  });

  test("never leaves half an emoji at the cut", () => {
    const result = truncateAtWord(`${"a".repeat(8)}😀${"b".repeat(20)}`, 10);
    expect(result).toBe(`${"a".repeat(8)}…`);
  });

  test("cuts a single overlong word hard", () => {
    expect(truncateAtWord("a".repeat(50), 10)).toBe(`${"a".repeat(9)}…`);
  });
});
