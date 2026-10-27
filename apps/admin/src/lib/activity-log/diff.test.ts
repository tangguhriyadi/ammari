import { describe, expect, test } from "vitest";
import { buildEntryDiff, displayValue } from "./diff";
import { REDACTED_TEXT, fieldLabel, isSecretKey, redact } from "./fields";

describe("redaction", () => {
  test("keys that look like secrets, tokens, passwords or OTPs", () => {
    for (const key of ["tokenHash", "token", "accessToken", "token_hash", "secret", "clientSecret", "password", "passwordHash", "otp", "otpCode", "otp_code", "apiKey", "api_key", "privateKey", "signature", "cookie", "hash", "salt", "pin", "jwt", "authorization", "csrfToken"]) {
      expect(isSecretKey(key), key).toBe(true);
    }
  });

  test("ordinary keys stay visible, even ones containing those letters", () => {
    for (const key of ["storageKey", "key", "stickerCode", "orderNo", "photo", "footprint", "sessionsRevoked", "hotpink", "bankAccountNo", "email", "ip", "roleKey"]) {
      expect(isSecretKey(key), key).toBe(false);
    }
  });

  test("redact replaces secret values at any depth, inside arrays too, without mutating the input", () => {
    const input = { id: "c1", tokenHash: "abc", nested: { password: "p", keep: 1 }, list: [{ otpCode: "123456", name: "x" }] };
    expect(redact(input)).toEqual({ id: "c1", tokenHash: REDACTED_TEXT, nested: { password: REDACTED_TEXT, keep: 1 }, list: [{ otpCode: REDACTED_TEXT, name: "x" }] });
    expect(input.tokenHash).toBe("abc");
  });

  test("a thank_you_card row (as written on print/claim) never shows its token hash", () => {
    const card = { id: "c1", status: "active", tokenHash: "deadbeef", stickerCode: "SHP-1234" };
    const diff = buildEntryDiff(card, { ...card, status: "claimed", tokenHash: "deadbeef2" });
    const tokenRow = diff.rows.find((row) => row.key === "tokenHash");
    expect(tokenRow?.before).toEqual({ kind: "redacted" });
    expect(tokenRow?.after).toEqual({ kind: "redacted" });
    expect(JSON.stringify(diff)).not.toContain("deadbeef");
    expect(diff.rows.find((row) => row.key === "stickerCode")?.after).toEqual({ kind: "text", text: "SHP-1234" });
  });

  test("secrets nested in a JSON value never reach the collapsible text", () => {
    const value = displayValue("items", [{ sku: "A", token: "t0p" }]);
    expect(value.kind).toBe("long");
    expect(JSON.stringify(value)).not.toContain("t0p");
    expect(JSON.stringify(value)).toContain(REDACTED_TEXT);
  });

  test("a nested object under a secret key is not flattened into visible fields", () => {
    const diff = buildEntryDiff(null, { credentials: { user: "u", pass: "p" } });
    expect(diff.rows).toEqual([{ key: "credentials", label: "credentials", before: null, after: { kind: "redacted" }, changed: true }]);
  });
});

describe("value display", () => {
  test("empty, booleans, numbers and money", () => {
    expect(displayValue("notes", null)).toEqual({ kind: "empty" });
    expect(displayValue("notes", "")).toEqual({ kind: "empty" });
    expect(displayValue("isActive", true)).toEqual({ kind: "text", text: "Ya" });
    expect(displayValue("isActive", false)).toEqual({ kind: "text", text: "Tidak" });
    expect(displayValue("qty", 1.5)).toEqual({ kind: "text", text: "1.5" });
    expect(displayValue("totalAmount", 259000)).toEqual({ kind: "text", text: "Rp 259.000" });
    expect(displayValue("basePrice", 1000)).toEqual({ kind: "text", text: "Rp 1.000" });
    expect(displayValue("purchase.valueAmount", 5000)).toEqual({ kind: "text", text: "Rp 5.000" });
  });

  test("timestamps show in Jakarta time; calendar dates stay as they are", () => {
    expect(displayValue("createdAt", "2026-10-27T17:30:00.000Z")).toEqual({ kind: "text", text: "28 Okt 2026, 00.30" });
    expect(displayValue("paidAt", "2026-10-27")).toEqual({ kind: "text", text: "2026-10-27" });
  });

  test("long text and JSON are collapsible with a short summary", () => {
    const long = "a".repeat(200);
    expect(displayValue("description", long)).toMatchObject({ kind: "long", text: long });
    expect(displayValue("lines", [{ a: 1 }, { a: 2 }])).toMatchObject({ kind: "long", summary: "2 item" });
    expect(displayValue("lines", [])).toEqual({ kind: "text", text: "(tidak ada)" });
  });
});

describe("buildEntryDiff", () => {
  test("an update: one row per field with Indonesian labels, changed ones flagged", () => {
    const diff = buildEntryDiff({ id: "o1", status: "to_ship", notes: null }, { id: "o1", status: "shipped", notes: "dikirim pagi" });
    expect(diff.mode).toBe("change");
    expect(diff.rows.map((row) => [row.label, row.changed])).toEqual([
      ["ID", false],
      ["Status", true],
      ["Catatan", true],
    ]);
    expect(diff.rows[1]).toMatchObject({ before: { kind: "text", text: "to_ship" }, after: { kind: "text", text: "shipped" } });
  });

  test("a create shows only the recorded fields; a delete only the old ones", () => {
    const created = buildEntryDiff(null, { name: "Toko Laksmi" });
    expect(created.mode).toBe("created");
    expect(created.rows).toEqual([{ key: "name", label: "Nama", before: null, after: { kind: "text", text: "Toko Laksmi" }, changed: true }]);

    const removed = buildEntryDiff({ name: "Katun" }, null);
    expect(removed.mode).toBe("removed");
    expect(removed.rows[0]).toMatchObject({ before: { kind: "text", text: "Katun" }, after: null });
  });

  test("a field only on one side, and keys unknown to the label map (raw key)", () => {
    const diff = buildEntryDiff({ a: 1 }, { brandNewField: "x" });
    expect(diff.rows.map((row) => row.label)).toEqual(["brandNewField", "a"]);
    expect(diff.rows[1]).toMatchObject({ before: { kind: "text", text: "1" }, after: { kind: "empty" }, changed: true });
  });

  test("nested objects are flattened one level with a combined label", () => {
    const diff = buildEntryDiff(null, { purchase: { purchaseNo: "PO-1", status: "ordered" }, lines: [{ qty: 2 }] });
    expect(diff.rows.map((row) => [row.key, row.label])).toEqual([
      ["purchase.purchaseNo", "Pembelian / No. pembelian"],
      ["purchase.status", "Pembelian / Status"],
      ["lines", "Baris"],
    ]);
  });

  test("no payload at all, and a payload that is not an object", () => {
    expect(buildEntryDiff(null, null)).toEqual({ mode: "empty", rows: [] });
    expect(buildEntryDiff(null, ["a"]).rows[0]).toMatchObject({ key: "nilai", label: "Nilai" });
    // A bare scalar has no key to judge it by, so it is never shown.
    expect(buildEntryDiff(null, "maybe-a-token").rows[0]).toMatchObject({ key: "nilai", after: { kind: "redacted" } });
  });

  test("fieldLabel falls back to the raw key, including prototype names", () => {
    expect(fieldLabel("orderNo")).toBe("No. pesanan");
    expect(fieldLabel("somethingNew")).toBe("somethingNew");
    expect(fieldLabel("constructor")).toBe("constructor");
  });
});
