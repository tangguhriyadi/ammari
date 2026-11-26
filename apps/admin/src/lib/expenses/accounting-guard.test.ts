import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

// docs/plans/expense-master-data.md §3.11 (session S6): supplier payments (purchases, production)
// reach Laba bersih only as HPP of sold orders. The behavioural guard lives in summary.test.ts;
// this one pins the wiring so a later edit cannot quietly route them into the profit path: the
// P&L, ROAS, report and Overview modules never read supplier_payments, and never import the two
// cash-flow readers, which only the Biaya page may use.

const ROOT = path.resolve(__dirname, "../../..");
const PROFIT_PATH = [
  "src/lib/expenses/figures.ts",
  "src/lib/expenses/summary.ts",
  "src/lib/expenses/report.ts",
  "src/lib/expenses/report-content.ts",
  "src/lib/expenses/report-pdf.ts",
  "src/lib/expenses/report-xlsx.ts",
  "src/lib/overview/queries.ts",
  "src/app/(shell)/_components/overview-kpi-tiles.tsx",
  "src/components/expenses/expense-summary.tsx",
];

function code(file: string): string {
  // Comments may name the table (to say it is NOT read); only code counts.
  return readFileSync(path.join(ROOT, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("accounting guard: the profit path never reads supplier payments", () => {
  test.each(PROFIT_PATH)("%s", (file) => {
    const source = code(file);
    expect(source).not.toMatch(/supplierPayments|supplier_payments/);
    expect(source).not.toMatch(/production-outflow|cash-outflow/);
  });

  test("the cash-flow readers are imported only by the Biaya page and its components", () => {
    const sources = (readdirSync(path.join(ROOT, "src"), { recursive: true }) as string[])
      .map((file) => path.join("src", file).split(path.sep).join("/"))
      .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file));
    const importers = sources.filter((file) => /from "[^"]*\/(production-outflows|cash-outflow)"/.test(code(file))).sort();
    // The Biaya page (expenses/page.tsx) mounts the two components.
    expect(importers).toEqual([
      "src/components/expenses/cash-outflow-summary.tsx",
      "src/components/expenses/production-outflow-section.tsx",
      "src/lib/expenses/cash-outflow.ts",
    ]);
  });
});
