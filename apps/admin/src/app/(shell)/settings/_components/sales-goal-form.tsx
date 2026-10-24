"use client";

import { useState, useTransition, type FormEvent } from "react";
import { Button, Input, Label, useToast } from "@ammari/ui";
import { formatDate, formatNumber } from "@ammari/ui/lib";
import { calendarDaysBetween, isCalendarDate, jakartaMidnight } from "@ammari/commerce/jakarta-day";
import { goalWindow } from "@/lib/overview/goal";
import { saveSalesGoalAction } from "../actions";

export interface SalesGoalFormValues {
  /** Whole rupiah, as digits only ("" when empty). */
  revenueTargetDigits: string;
  /** "YYYY-MM-DD" or "". */
  startDate: string;
}

type FieldErrors = Partial<Record<"revenueTarget" | "startDate", string>>;

/** "1000000000" -> "1.000.000.000". The digits stay the state; the dots are display only. */
function withThousandSeparators(digits: string): string {
  return digits === "" ? "" : formatNumber(Number(digits));
}

function calendarDateLabel(date: string): string {
  return formatDate(jakartaMidnight(date));
}

/** "Target penjualan" (docs/plans/dashboard-overview.md §2.2). Validation is the server's
 * (salesGoalSchema); the field only keeps digits so the dots it shows can never be ambiguous.
 * Moving a saved start date that is today or earlier recomputes progress the owner has already
 * seen, so the form says so. `today` is the Jakarta calendar date from the server. */
export function SalesGoalForm({ initialValues, today }: { initialValues: SalesGoalFormValues; today: string }) {
  const [values, setValues] = useState(initialValues);
  const [saved, setSaved] = useState(initialValues);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const toast = useToast();

  const yearWindow = isCalendarDate(values.startDate) ? goalWindow({ revenueTargetAmount: 1, startDate: values.startDate }) : null;
  const yearStarted = isCalendarDate(saved.startDate) && calendarDaysBetween(saved.startDate, today) >= 0;
  const startDateMoved = yearStarted && values.startDate !== saved.startDate;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrors({});
    setFormError(null);
    // What is sent is what gets saved; the inputs are disabled until the answer comes back.
    const submitted = values;
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof saveSalesGoalAction>>;
      try {
        result = await saveSalesGoalAction({ revenueTarget: submitted.revenueTargetDigits, startDate: submitted.startDate });
      } catch {
        // A database failure (runAction rethrows it) or a dropped connection.
        setFormError("Target belum tersimpan. Periksa koneksi lalu coba lagi.");
        return;
      }
      if (!result.ok) {
        if (result.fieldErrors && Object.keys(result.fieldErrors).length > 0) setErrors(result.fieldErrors);
        else setFormError(result.error);
        return;
      }
      setSaved(submitted);
      toast.success("Target penjualan disimpan");
    });
  }

  return (
    <form aria-labelledby="sales-goal-heading" className="flex max-w-xl flex-col gap-4" onSubmit={handleSubmit} noValidate>
      <div className="flex flex-col gap-1">
        <h2 id="sales-goal-heading" className="text-lg font-semibold text-neutral-900">
          Target penjualan
        </h2>
        <p className="text-pretty text-sm text-neutral-600">
          Target omzet satu tahun untuk kartu target di Ringkasan. Omzet dihitung dari penjualan barang setelah voucher, tanpa ongkir.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="sales-goal-amount">Target omzet per tahun</Label>
        <div className="relative">
          <span aria-hidden="true" className="pointer-events-none absolute top-0 left-3 flex h-11 items-center text-base text-neutral-600">
            Rp
          </span>
          <Input
            id="sales-goal-amount"
            name="revenueTarget"
            disabled={pending}
            inputMode="numeric"
            autoComplete="off"
            className="pl-10 tabular-nums"
            value={withThousandSeparators(values.revenueTargetDigits)}
            onChange={(event) => {
              // Leading zeros dropped, capped at 15 digits so the display number stays exact; the
              // real limit is the server's.
              const digits = event.target.value.replace(/\D/g, "").replace(/^0+(?=\d)/, "").slice(0, 15);
              setValues((prev) => ({ ...prev, revenueTargetDigits: digits }));
              setErrors((prev) => ({ ...prev, revenueTarget: undefined }));
            }}
            placeholder="1.000.000.000"
            aria-describedby="sales-goal-amount-hint"
            error={errors.revenueTarget}
          />
        </div>
        <p id="sales-goal-amount-hint" className="text-sm text-neutral-600">
          Rupiah tanpa desimal, maksimal Rp 100.000.000.000.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="sales-goal-start-date">Tanggal mulai</Label>
        <Input
          id="sales-goal-start-date"
          name="startDate"
          type="date"
          disabled={pending}
          className="sm:max-w-56"
          value={values.startDate}
          onChange={(event) => {
            setValues((prev) => ({ ...prev, startDate: event.target.value }));
            setErrors((prev) => ({ ...prev, startDate: undefined }));
          }}
          aria-describedby="sales-goal-start-date-hint"
          error={errors.startDate}
        />
        <p id="sales-goal-start-date-hint" className="text-sm text-neutral-600">
          {yearWindow
            ? `Tahun target: ${calendarDateLabel(yearWindow.startDate)} s.d. ${calendarDateLabel(yearWindow.endDate)} (${yearWindow.totalDays} hari).`
            : "Tahun target berjalan satu tahun penuh sejak tanggal ini."}
        </p>
        {startDateMoved && (
          <p className="text-sm text-warning-700" data-testid="sales-goal-recalculate-note">
            Progres akan dihitung ulang dari tanggal ini.
          </p>
        )}
      </div>

      {formError && (
        <p role="alert" className="text-sm text-danger-700">
          {formError}
        </p>
      )}

      <div className="flex justify-end">
        <Button type="submit" loading={pending}>
          Simpan
        </Button>
      </div>
    </form>
  );
}
