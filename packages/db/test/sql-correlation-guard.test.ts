import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// Guards against the exact incident this test is named for (2026-10-15): a hand-written `sql`
// fragment that correlates two DIFFERENT tables' columns via bare `${table.column}`
// interpolation — e.g. `${stockMovements.sku} = ${productVariants.sku}` — instead of
// `qualifiedColumn()` (packages/db/src/sql-helpers.ts). Confirmed empirically: drizzle-orm
// 0.45.3 renders that bare interpolation WITHOUT table qualification whenever the enclosing
// query has no `.innerJoin`/`.leftJoin`, silently turning the intended correlation into a
// self-comparison (always true) that aggregates the wrong rows. See sql-helpers.ts's doc
// comment on `qualifiedColumn` for the full writeup.
//
// This scans every .ts/.tsx source file in the repo (excluding build output, node_modules, and
// test files) for that textual shape and fails if it finds a NEW occurrence outside the small,
// explicitly-justified ALLOWLIST below. Finding a real hit means: either wrap both sides in
// `qualifiedColumn()`, or — if the surrounding `sql` composition also interpolates both tables
// directly (the one case this project has confirmed safe, see the purchases.ts entry below) —
// add it to the allowlist with a comment explaining why it's safe.

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../../../..");

const SCAN_ROOTS = ["apps/admin/src", "apps/web/src", "packages/auth/src", "packages/commerce/src", "packages/db/src", "packages/storage/src", "packages/ui/src"];

const EXCLUDED_DIR_NAMES = new Set(["node_modules", ".next", ".turbo", "dist", "build", "coverage"]);

/** Two different-table column interpolations compared via a relational operator, with nothing
 * but whitespace between the `${...}` and the operator on either side — the textual shape that
 * can ONLY appear inside a raw `sql` template (plain drizzle builder calls like `eq(a.col,
 * b.col)` don't use `${}` at all). Deliberately narrow (misses e.g. a cast like `::text`
 * in between, or a third intervening literal) — a narrow guard with no false positives is more
 * useful here than a broad one nobody can trust. */
const RISKY_CORRELATION = /\$\{(\w+)\.(\w+)\}\s*(?:=|<>|!=|>=|<=|>|<)\s*\$\{(\w+)\.(\w+)\}/g;

interface Allowlisted {
  file: string;
  reason: string;
}

// Each entry here was manually verified (rendered the real SQL via drizzle's dialect and/or ran
// it against real seeded data) to NOT exhibit the bug, despite matching the regex above.
const ALLOWLIST: Allowlisted[] = [
  {
    file: "apps/admin/src/lib/inventory/purchases.ts",
    reason:
      "listAllPurchases' UNION ALL query interpolates every table it touches as a bare ${Table} " +
      "reference (`from ${fabricStockMovements} inner join ${fabrics} on ...`) within the SAME " +
      "combined sql composition, which drizzle-orm 0.45.3 confirmed DOES properly qualify every " +
      "column reference in that case (verified via db.dialect.sqlToQuery against this exact " +
      "construct, and by the existing listPurchases test asserting correct per-row itemId).",
  },
];

function isAllowlisted(relativeFile: string): string | undefined {
  return ALLOWLIST.find((entry) => entry.file === relativeFile)?.reason;
}

function listSourceFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (EXCLUDED_DIR_NAMES.has(entry)) continue;
    const full = path.join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      files.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".test.ts") && !entry.endsWith(".test.tsx")) {
      files.push(full);
    }
  }
  return files;
}

function lineNumberAt(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

describe("sql-correlation-guard", () => {
  test("no NEW hand-written sql`` correlation between two different tables skips qualifiedColumn()", () => {
    const failures: string[] = [];

    for (const scanRoot of SCAN_ROOTS) {
      const absoluteRoot = path.join(repoRoot, scanRoot);
      for (const absoluteFile of listSourceFiles(absoluteRoot)) {
        const relativeFile = path.relative(repoRoot, absoluteFile);
        if (relativeFile.endsWith("packages/db/src/sql-helpers.ts")) continue; // defines the pattern safely

        const content = readFileSync(absoluteFile, "utf8");
        for (const match of content.matchAll(RISKY_CORRELATION)) {
          const [, tableA, , tableB] = match;
          if (tableA === tableB) continue; // same table on both sides — never ambiguous

          const allowlistReason = isAllowlisted(relativeFile);
          if (allowlistReason) continue;

          const line = lineNumberAt(content, match.index ?? 0);
          failures.push(
            `${relativeFile}:${line} — "${match[0]}" correlates "${tableA}" against "${tableB}" via bare ` +
              `interpolation inside a sql\`\` fragment. Use qualifiedColumn() from ` +
              `@ammari/db/sql-helpers for both sides (see that file's doc comment), or add a ` +
              `justified ALLOWLIST entry here if you've verified it's safe.`,
          );
        }
      }
    }

    expect(failures).toEqual([]);
  });
});
