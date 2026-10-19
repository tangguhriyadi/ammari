import { describe, expect, test } from "vitest";
import { closedStatus, isOpenPurchaseStatus, receiptProgressStatus, statusAfterReceiptChange } from "./status";

// docs/plans/suppliers-goods-receipt.md §5 step 7 and D19.

const line = (qtyOrdered: number, accepted: number, rejected = 0) => ({ qtyOrdered, accepted, rejected });

describe("receiptProgressStatus", () => {
  test("nothing received yet is ordered", () => {
    expect(receiptProgressStatus([line(10, 0), line(5, 0)])).toBe("ordered");
  });

  test("some received on one line is partially_received", () => {
    expect(receiptProgressStatus([line(10, 4), line(5, 0)])).toBe("partially_received");
  });

  test("one line complete and another not is still partially_received", () => {
    expect(receiptProgressStatus([line(10, 10), line(5, 2)])).toBe("partially_received");
  });

  test("every line complete is received, compared exactly in hundredths", () => {
    expect(receiptProgressStatus([line(10.5, 10.5), line(0.3, 0.1 + 0.2)])).toBe("received");
  });

  test("rejects count as arrived but never complete a line (§4.2: 8 good + 2 defective of 10)", () => {
    expect(receiptProgressStatus([line(10, 8, 2)])).toBe("partially_received");
    expect(receiptProgressStatus([line(10, 0, 2)])).toBe("partially_received");
    expect(receiptProgressStatus([line(10, 10, 0), line(3, 0, 3)])).toBe("partially_received");
  });

  test("after the only receipt is reversed the document is back to ordered", () => {
    expect(receiptProgressStatus([line(10, 0)])).toBe("ordered");
  });
});

describe("closedStatus (D19)", () => {
  test("nothing arrived: cancelled", () => {
    expect(closedStatus([line(10, 0), line(5, 0)])).toBe("cancelled");
  });

  test("anything arrived: closed", () => {
    expect(closedStatus([line(10, 0), line(5, 1)])).toBe("closed");
  });

  test("only defective units arrived: still closed, not cancelled (accepted = 0 AND rejected = 0)", () => {
    expect(closedStatus([line(10, 0, 2), line(5, 0)])).toBe("closed");
  });
});

describe("statusAfterReceiptChange", () => {
  test("an open document follows the receipts", () => {
    expect(statusAfterReceiptChange("ordered", [line(10, 3)])).toBe("partially_received");
    expect(statusAfterReceiptChange("partially_received", [line(10, 10)])).toBe("received");
    expect(statusAfterReceiptChange("received", [line(10, 6)])).toBe("partially_received");
  });

  test("a closed document stays closed, flipping to cancelled once nothing remains received", () => {
    expect(statusAfterReceiptChange("closed", [line(10, 3)])).toBe("closed");
    expect(statusAfterReceiptChange("closed", [line(10, 0)])).toBe("cancelled");
  });
});

describe("isOpenPurchaseStatus", () => {
  test("only ordered and partially_received accept receipts and closing", () => {
    expect(isOpenPurchaseStatus("ordered")).toBe(true);
    expect(isOpenPurchaseStatus("partially_received")).toBe(true);
    expect(isOpenPurchaseStatus("received")).toBe(false);
    expect(isOpenPurchaseStatus("closed")).toBe(false);
    expect(isOpenPurchaseStatus("cancelled")).toBe(false);
  });
});
