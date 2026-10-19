import { describe, expect, test } from "vitest";
import { batchReceiptProgressStatus, batchStatusAfterReceiptChange, isOpenBatchReceiptStatus } from "./receipt-status";

describe("batchReceiptProgressStatus", () => {
  test("nothing received on any line is pending", () => {
    expect(batchReceiptProgressStatus([{ planned: 3, received: 0, rejected: 0 }, { planned: 2, received: 0, rejected: 0 }])).toBe("pending");
  });

  test("some but not all is partially received, per line", () => {
    expect(batchReceiptProgressStatus([{ planned: 3, received: 3, rejected: 0 }, { planned: 2, received: 0, rejected: 0 }])).toBe("partially_received");
    expect(batchReceiptProgressStatus([{ planned: 3, received: 1, rejected: 0 }, { planned: 2, received: 0, rejected: 0 }])).toBe("partially_received");
  });

  test("rejects count as arrived but never complete a line", () => {
    expect(batchReceiptProgressStatus([{ planned: 3, received: 0, rejected: 1 }])).toBe("partially_received");
    expect(batchReceiptProgressStatus([{ planned: 3, received: 2, rejected: 1 }])).toBe("partially_received");
  });

  test("every line at its planned pcs is received", () => {
    expect(batchReceiptProgressStatus([{ planned: 3, received: 3, rejected: 0 }, { planned: 2, received: 2, rejected: 0 }])).toBe("received");
  });
});

describe("batchStatusAfterReceiptChange", () => {
  test("follows the receipts for every open or received status", () => {
    const partial = [{ planned: 3, received: 1, rejected: 0 }];
    expect(batchStatusAfterReceiptChange("pending", partial)).toBe("partially_received");
    expect(batchStatusAfterReceiptChange("received", partial)).toBe("partially_received");
    expect(batchStatusAfterReceiptChange("partially_received", [{ planned: 3, received: 0, rejected: 0 }])).toBe("pending");
  });

  test("a closed batch stays closed whatever the receipts do", () => {
    expect(batchStatusAfterReceiptChange("closed", [{ planned: 3, received: 0, rejected: 0 }])).toBe("closed");
    expect(batchStatusAfterReceiptChange("closed", [{ planned: 3, received: 3, rejected: 0 }])).toBe("closed");
  });
});

test("only pending and partially received accept receipts and a short-close", () => {
  expect(isOpenBatchReceiptStatus("pending")).toBe(true);
  expect(isOpenBatchReceiptStatus("partially_received")).toBe(true);
  expect(isOpenBatchReceiptStatus("received")).toBe(false);
  expect(isOpenBatchReceiptStatus("closed")).toBe(false);
});
