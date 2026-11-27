import { jakartaDate } from "@ammari/commerce/jakarta-day";
import { parseAsOfDate } from "@/lib/accounting/filters";
import { searchValue, statementExportResponse } from "@/lib/accounting/statement-export";
import { getBalanceSheet } from "@/lib/accounting/statements";

// Neraca PDF / Excel (docs/plans/accounting.md §6, Session 10). accounting.view; audited.
export function GET(request: Request): Promise<Response> {
  return statementExportResponse(request, (search) => getBalanceSheet(parseAsOfDate({ date: searchValue(search, "date") }, jakartaDate())));
}
