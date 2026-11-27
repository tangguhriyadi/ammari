import { jakartaDate } from "@ammari/commerce/jakarta-day";
import { parseDateRange } from "@/lib/accounting/filters";
import { searchValue, statementExportResponse } from "@/lib/accounting/statement-export";
import { getCashFlow } from "@/lib/accounting/statements";

// Arus kas PDF / Excel (docs/plans/accounting.md §6, Session 10). accounting.view; audited.
export function GET(request: Request): Promise<Response> {
  return statementExportResponse(request, (search) => getCashFlow(parseDateRange({ from: searchValue(search, "from"), to: searchValue(search, "to") }, jakartaDate())));
}
