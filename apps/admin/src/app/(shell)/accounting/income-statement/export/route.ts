import { jakartaDate } from "@ammari/commerce/jakarta-day";
import { parseDateRange, parseIncomeStatementView } from "@/lib/accounting/filters";
import { searchValue, statementExportResponse } from "@/lib/accounting/statement-export";
import { getIncomeStatement } from "@/lib/accounting/statements";

// Laba rugi PDF / Excel (docs/plans/accounting.md §6, Session 10). accounting.view; audited.
export function GET(request: Request): Promise<Response> {
  return statementExportResponse(request, (search) =>
    getIncomeStatement(parseDateRange({ from: searchValue(search, "from"), to: searchValue(search, "to") }, jakartaDate()), parseIncomeStatementView({ view: searchValue(search, "view") })),
  );
}
