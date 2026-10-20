// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { TrustRow } from "./trust-row";

describe("TrustRow", () => {
  test("shows exactly the three owner-approved items, in order", () => {
    render(<TrustRow />);
    const items = screen.getAllByRole("listitem").map((item) => item.textContent);
    expect(items).toEqual(["Pembayaran Aman", "Gratis Ongkir Ke Seluruh Indonesia", "Proses Cepat"]);
  });
});
