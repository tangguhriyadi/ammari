import { describe, expect, test } from "vitest";
import { CHART_OF_ACCOUNTS } from "@ammari/db/accounting";
import { FieldError } from "@/lib/errors";
import {
  FIXED_ASSET_MESSAGES,
  normalizeVoidReason,
  validateFixedAsset,
  validateFixedAssetDisposal,
  validateGroupInput,
  validateThresholdInput,
  type FixedAssetAccountInfo,
} from "./fixed-asset-input";

// D-19 register input (Session 11): threshold, group, accounts of the right kind, dates.

const accounts = new Map<string, FixedAssetAccountInfo>(CHART_OF_ACCOUNTS.map((row) => [row.code, { type: row.type, normalBalance: row.normalBalance, isActive: true, isHeader: row.isHeader }]));
const context = { today: "2027-03-15", groups: new Map([["group_1", 48], ["group_2", 96]]), capitalizationThreshold: 1_000_000, accounts };
const input = { name: " Mesin  jahit ", groupCode: "group_1", acquisitionDate: "2027-01-20", cost: "12.000.000", assetAccountCode: "1-2101", accumulatedAccountCode: "1-2191", fundingAccountCode: "1-1201", note: "" };

function fieldOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof FieldError) return error.field;
    throw error;
  }
  throw new Error("expected a FieldError");
}

describe("validateFixedAsset", () => {
  test("valid input: trimmed name, months from the group, cost in rupiah", () => {
    expect(validateFixedAsset(input, context)).toEqual({
      name: "Mesin jahit",
      groupCode: "group_1",
      usefulLifeMonths: 48,
      acquisitionDate: "2027-01-20",
      cost: 12_000_000,
      assetAccountCode: "1-2101",
      accumulatedAccountCode: "1-2191",
      fundingAccountCode: "1-1201",
      note: null,
    });
    expect(validateFixedAsset({ ...input, groupCode: "group_2", fundingAccountCode: "" }, context)).toMatchObject({ usefulLifeMonths: 96, fundingAccountCode: null });
    expect(validateFixedAsset({ ...input, fundingAccountCode: "2-2101" }, context).fundingAccountCode).toBe("2-2101");
  });

  test("the Rp1.000.000 capitalisation threshold (exactly the threshold is an asset)", () => {
    expect(() => validateFixedAsset({ ...input, cost: "999.999" }, context)).toThrow(FIXED_ASSET_MESSAGES.belowThreshold("Rp1.000.000"));
    expect(validateFixedAsset({ ...input, cost: "1000000" }, context).cost).toBe(1_000_000);
  });

  test("refusals", () => {
    expect(fieldOf(() => validateFixedAsset({ ...input, name: " " }, context))).toBe("name");
    expect(fieldOf(() => validateFixedAsset({ ...input, groupCode: "group_9" }, context))).toBe("groupCode");
    expect(fieldOf(() => validateFixedAsset({ ...input, acquisitionDate: "2027-02-30" }, context))).toBe("acquisitionDate");
    expect(fieldOf(() => validateFixedAsset({ ...input, acquisitionDate: "2027-03-16" }, context))).toBe("acquisitionDate");
    expect(fieldOf(() => validateFixedAsset({ ...input, cost: "0" }, context))).toBe("cost");
    expect(fieldOf(() => validateFixedAsset({ ...input, cost: "1,5" }, context))).toBe("cost");
    // An accumulated (credit-normal) account is not an asset account, and the reverse.
    expect(fieldOf(() => validateFixedAsset({ ...input, assetAccountCode: "1-2191" }, context))).toBe("assetAccountCode");
    expect(fieldOf(() => validateFixedAsset({ ...input, accumulatedAccountCode: "1-2101" }, context))).toBe("accumulatedAccountCode");
    // Inventory is never a fixed asset; an expense is never the funding side.
    expect(fieldOf(() => validateFixedAsset({ ...input, assetAccountCode: "1-1504" }, context))).toBe("assetAccountCode");
    expect(fieldOf(() => validateFixedAsset({ ...input, fundingAccountCode: "6-2101" }, context))).toBe("fundingAccountCode");
    const inactive = new Map(accounts);
    inactive.set("1-2101", { ...(accounts.get("1-2101") as FixedAssetAccountInfo), isActive: false });
    expect(fieldOf(() => validateFixedAsset(input, { ...context, accounts: inactive }))).toBe("assetAccountCode");
  });
});

describe("validateFixedAssetDisposal", () => {
  const disposal = { today: "2027-03-15", acquisitionDate: "2027-01-20", accounts };
  test("a sale needs a Kas & Bank account; a scrap does not", () => {
    expect(validateFixedAssetDisposal({ disposedOn: "2027-03-01", proceeds: "5.000.000", cashAccountCode: "1-1101" }, disposal)).toEqual({ disposedOn: "2027-03-01", disposalProceeds: 5_000_000, disposalCashAccountCode: "1-1101" });
    expect(validateFixedAssetDisposal({ disposedOn: "2027-03-01", proceeds: "", cashAccountCode: "1-1101" }, disposal)).toEqual({ disposedOn: "2027-03-01", disposalProceeds: 0, disposalCashAccountCode: null });
    expect(fieldOf(() => validateFixedAssetDisposal({ disposedOn: "2027-03-01", proceeds: "5", cashAccountCode: "" }, disposal))).toBe("cashAccountCode");
    expect(fieldOf(() => validateFixedAssetDisposal({ disposedOn: "2027-03-01", proceeds: "5", cashAccountCode: "1-1301" }, disposal))).toBe("cashAccountCode");
  });
  test("dates", () => {
    expect(fieldOf(() => validateFixedAssetDisposal({ disposedOn: "2027-01-19", proceeds: "0", cashAccountCode: "" }, disposal))).toBe("disposedOn");
    expect(fieldOf(() => validateFixedAssetDisposal({ disposedOn: "2027-03-16", proceeds: "0", cashAccountCode: "" }, disposal))).toBe("disposedOn");
    expect(fieldOf(() => validateFixedAssetDisposal({ disposedOn: "x", proceeds: "0", cashAccountCode: "" }, disposal))).toBe("disposedOn");
  });
});

describe("settings and void", () => {
  test("group life 1..600 months; threshold whole rupiah ≥ 0; void reason required", () => {
    expect(validateGroupInput({ label: "Kelompok 1", usefulLifeMonths: "48" })).toEqual({ label: "Kelompok 1", usefulLifeMonths: 48 });
    expect(fieldOf(() => validateGroupInput({ label: "Kelompok 1", usefulLifeMonths: "0" }))).toBe("usefulLifeMonths");
    expect(fieldOf(() => validateGroupInput({ label: "Kelompok 1", usefulLifeMonths: "601" }))).toBe("usefulLifeMonths");
    expect(fieldOf(() => validateGroupInput({ label: " ", usefulLifeMonths: "48" }))).toBe("label");
    expect(validateThresholdInput("1.000.000")).toBe(1_000_000);
    expect(validateThresholdInput("0")).toBe(0);
    expect(fieldOf(() => validateThresholdInput("-1"))).toBe("capitalizationThreshold");
    expect(normalizeVoidReason("  salah catat ")).toBe("salah catat");
    expect(fieldOf(() => normalizeVoidReason(" "))).toBe("reason");
  });
});
