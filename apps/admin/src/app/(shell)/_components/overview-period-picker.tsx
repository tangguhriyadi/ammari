import { Button, FilterTabs, Input, Label } from "@ammari/ui";
import { DEFAULT_OVERVIEW_PERIOD, MAX_CUSTOM_PERIOD_DAYS, type OverviewPeriod, type ResolvedPeriod } from "@/lib/overview/period";

const PERIOD_LABELS: Record<OverviewPeriod, string> = {
  today: "Hari ini",
  yesterday: "Kemarin",
  "7d": "7 hari",
  month: "Bulan ini",
  custom: "Pilih tanggal",
};

// Tab order puts the default first (D5) and "Hari ini" one tap away. The default has no param, so
// a bare "/" is Kemarin and its tab is active there.
const TAB_ORDER: readonly OverviewPeriod[] = ["yesterday", "today", "7d", "month", "custom"];
const PERIOD_OPTIONS = TAB_ORDER.map((period) => ({
  label: PERIOD_LABELS[period],
  value: period === DEFAULT_OVERVIEW_PERIOD ? undefined : period,
}));

/** URL-driven like every filter in the admin: no client state, so the selected period survives a
 * reload and a shared link. "Pilih tanggal" is a plain GET form: the server validates the range
 * (resolvePeriod), never the browser. */
export function OverviewPeriodPicker({
  resolved,
  customRequested,
  customAttempted,
  today,
}: {
  resolved: ResolvedPeriod;
  /** `?period=custom` was asked for, valid or not: the form stays open to fix it. */
  customRequested: boolean;
  /** A from or to date came with it (the form was sent), so an invalid range is worth saying. */
  customAttempted: boolean;
  today: string;
}) {
  const activeValue = customRequested ? "custom" : resolved.period === DEFAULT_OVERVIEW_PERIOD ? undefined : resolved.period;
  // Fell back to the default: say so only when dates were sent; a first tap just opens the form,
  // prefilled with the period on screen.
  const customInvalid = customRequested && customAttempted && resolved.period !== "custom";

  return (
    <div className="flex flex-col gap-3">
      <FilterTabs basePath="/" paramName="period" options={PERIOD_OPTIONS} activeValue={activeValue} aria-label="Pilih periode" />
      {customRequested && (
        <form method="get" action="/" className="flex flex-col gap-3 rounded-lg border border-neutral-200 bg-white p-4 sm:flex-row sm:items-end">
          <input type="hidden" name="period" value="custom" />
          <div className="grid grid-cols-2 gap-3 sm:flex">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="overview-from">Dari</Label>
              <Input id="overview-from" name="from" type="date" max={today} defaultValue={customInvalid ? "" : resolved.fromDate} required />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="overview-to">Sampai</Label>
              <Input id="overview-to" name="to" type="date" max={today} defaultValue={customInvalid ? "" : resolved.toDate} required />
            </div>
          </div>
          <Button type="submit" variant="secondary">
            Tampilkan
          </Button>
          {customInvalid && (
            <p role="alert" className="text-sm text-danger-700 sm:self-center">
              Pilih rentang yang valid, paling lama {MAX_CUSTOM_PERIOD_DAYS} hari dan tidak melewati hari ini. Sekarang menampilkan Kemarin.
            </p>
          )}
        </form>
      )}
    </div>
  );
}
