"use client";

import { useState, useTransition, type FormEvent } from "react";
import { Button, Checkbox, useToast } from "@ammari/ui";
import type { BusinessExpenseCategory } from "@ammari/db/schema";
import { saveMonthlyBillsReminderAction } from "../actions";

/** "Pengingat biaya bulanan" (docs/plans/growth.md §6, owner answer A6): which categories must be
 * recorded every month. From the 6th, Ringkasan's "Perlu tindakan" names each chosen one that has
 * no expense paid from the 6th of last month to the 5th of this month. Nothing chosen = off.
 * `options` are the active categories (owner answer D3), in display order; a chosen category that
 * was deactivated since is not offered and drops out on the next save. Validation is the server's
 * (parseMonthlyBillCategories). */
export function MonthlyBillsForm({
  options,
  initialCategories,
}: {
  options: readonly { code: BusinessExpenseCategory; name: string }[];
  initialCategories: readonly BusinessExpenseCategory[];
}) {
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set(initialCategories));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const toast = useToast();

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const categories = options.filter((option) => chosen.has(option.code)).map((option) => option.code);
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof saveMonthlyBillsReminderAction>>;
      try {
        result = await saveMonthlyBillsReminderAction({ categories });
      } catch {
        setError("Pengingat belum tersimpan. Periksa koneksi lalu coba lagi.");
        return;
      }
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast.success(categories.length > 0 ? "Pengingat biaya bulanan disimpan" : "Pengingat biaya bulanan dimatikan");
    });
  }

  return (
    <form aria-labelledby="monthly-bills-heading" className="flex max-w-xl flex-col gap-4" onSubmit={handleSubmit} noValidate>
      <div className="flex flex-col gap-1">
        <h2 id="monthly-bills-heading" className="text-lg font-semibold text-neutral-900">
          Pengingat biaya bulanan
        </h2>
        <p className="text-pretty text-sm text-neutral-600">
          Biaya yang wajib dicatat tiap bulan. Mulai tanggal 6, Ringkasan mengingatkan biaya bulan lalu yang belum dicatat (dibayar tanggal 6 bulan lalu s.d. tanggal 5
          bulan ini). Tidak ada yang dipilih berarti pengingat mati.
        </p>
      </div>
      <fieldset className="flex flex-col" aria-describedby={error ? "monthly-bills-error" : undefined}>
        <legend className="sr-only">Kategori yang wajib dicatat tiap bulan</legend>
        {options.map(({ code: category, name }) => (
          <Checkbox
            key={category}
            name="categories"
            value={category}
            label={name}
            disabled={pending}
            checked={chosen.has(category)}
            onChange={(event) => {
              const checked = event.target.checked;
              setChosen((prev) => {
                const next = new Set(prev);
                if (checked) next.add(category);
                else next.delete(category);
                return next;
              });
            }}
          />
        ))}
      </fieldset>
      {error && (
        <p id="monthly-bills-error" role="alert" className="text-sm text-danger-700">
          {error}
        </p>
      )}
      <div className="flex justify-end">
        <Button type="submit" loading={pending}>
          Simpan pengingat
        </Button>
      </div>
    </form>
  );
}
