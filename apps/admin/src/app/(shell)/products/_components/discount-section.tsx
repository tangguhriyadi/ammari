"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";
import { Badge, Button, Input, Label, Switch, useToast } from "@ammari/ui";
import { formatRupiah } from "@ammari/ui/lib";
import type { DiscountStatus } from "@ammari/db/pricing";
import {
  checkDiscountRules,
  DISCOUNT_DATETIME_FORMAT_MESSAGE,
  DISCOUNT_PRICE_FORMAT_MESSAGE,
  DISCOUNT_STATUS_BADGE_VARIANTS,
  DISCOUNT_STATUS_LABELS,
  jakartaLocalToUtc,
  percentTextForPrice,
  priceForPercentText,
  type DiscountField,
} from "@/lib/products/discount";
import { parseRupiah } from "@/lib/products/money";
import { clearProductDiscountAction, revalidateProductAction, updateProductDiscountAction } from "../actions";

export interface DiscountSectionValues {
  /** "Harga setelah diskon" as typed, "" when none is stored. */
  priceText: string;
  enabled: boolean;
  /** datetime-local values in WIB ("2026-11-01T00:00"), "" when empty. */
  startsAt: string;
  endsAt: string;
}

type FieldErrors = Partial<Record<DiscountField | "discountPercent", string>>;

/** Client-side mirror of the server rules, for messages while typing only; the server action
 * checks everything again. Never throws: every helper it calls is guarded. */
function liveErrors(basePrice: number, values: DiscountSectionValues, percentError: string | null): FieldErrors {
  const errors: FieldErrors = {};
  if (percentError) errors.discountPercent = percentError;

  const price = values.priceText.trim() === "" ? null : parseRupiah(values.priceText);
  if (values.priceText.trim() !== "" && price === null) errors.discountPriceAmount = DISCOUNT_PRICE_FORMAT_MESSAGE;
  const startsAt = values.startsAt === "" ? null : jakartaLocalToUtc(values.startsAt);
  if (values.startsAt !== "" && startsAt === null) errors.discountStartsAt = DISCOUNT_DATETIME_FORMAT_MESSAGE;
  const endsAt = values.endsAt === "" ? null : jakartaLocalToUtc(values.endsAt);
  if (values.endsAt !== "" && endsAt === null) errors.discountEndsAt = DISCOUNT_DATETIME_FORMAT_MESSAGE;

  const broken = checkDiscountRules(
    { basePrice, discountPriceAmount: price, discountEnabled: values.enabled, discountStartsAt: startsAt, discountEndsAt: endsAt },
    new Date(),
  );
  // A typed but unparseable price is already reported; don't also say "isi harga dulu" for it.
  if (broken && !errors[broken.field] && !(broken.field === "discountPriceAmount" && errors.discountPriceAmount)) {
    errors[broken.field] = broken.message;
  }
  return errors;
}

interface DiscountSectionProps {
  productId: string;
  /** The SAVED base price: the discount is checked against what is stored, not the unsaved
   * "Harga dasar" field of the form above. */
  basePrice: number;
  /** Computed on the server at render time from the saved values. */
  status: DiscountStatus;
  hasStoredDiscount: boolean;
  initialValues: DiscountSectionValues;
}

/** Owns what must survive a save: the "toko online belum diperbarui" warning. The form below is
 * keyed on the saved values, so after a save/clear + router.refresh() it remounts with what the
 * server now holds, while this wrapper (not keyed) keeps the warning and its retry button. */
export function DiscountSection(props: DiscountSectionProps) {
  const [revalidationWarning, setRevalidationWarning] = useState(false);
  const [retryPending, startRetry] = useTransition();
  const { initialValues, basePrice } = props;
  const formKey = [initialValues.priceText, initialValues.enabled, initialValues.startsAt, initialValues.endsAt, basePrice, props.status].join("|");

  function handleRetryRevalidation() {
    startRetry(async () => {
      const result = await revalidateProductAction(props.productId);
      setRevalidationWarning(!(result.ok && result.data.revalidationOk));
    });
  }

  return (
    <DiscountForm
      key={formKey}
      {...props}
      onRevalidation={(ok) => setRevalidationWarning(!ok)}
      revalidationWarning={
        revalidationWarning && (
          <p className="flex flex-wrap items-center gap-2 text-sm text-amber-800" data-testid="revalidation-warning">
            Perubahan tersimpan, tetapi toko online belum diperbarui.
            <button type="button" onClick={handleRetryRevalidation} disabled={retryPending} className="font-medium underline disabled:opacity-60">
              Coba lagi
            </button>
          </p>
        )
      }
    />
  );
}

function DiscountForm({
  productId,
  basePrice,
  status,
  hasStoredDiscount,
  initialValues,
  onRevalidation,
  revalidationWarning,
}: DiscountSectionProps & { onRevalidation: (ok: boolean) => void; revalidationWarning: ReactNode }) {
  const router = useRouter();
  const toast = useToast();
  const [values, setValues] = useState<DiscountSectionValues>(initialValues);
  const [percentText, setPercentText] = useState(() => percentTextForPrice(basePrice, initialValues.priceText));
  const [percentError, setPercentError] = useState<string | null>(null);
  const [serverErrors, setServerErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [pending, startTransition] = useTransition();
  const [clearPending, startClear] = useTransition();

  const errors = liveErrors(basePrice, values, percentError);
  // Format problems show at once; rule messages (e.g. "isi harga dulu" right after flipping the
  // toggle) once the owner has typed a price or tried to save, so a fresh form isn't all red.
  const visibleErrors: FieldErrors = { ...(showErrors || values.priceText.trim() !== "" ? errors : pickFormatErrors(errors)), ...serverErrors };

  function update(patch: Partial<DiscountSectionValues>) {
    setValues((prev) => ({ ...prev, ...patch }));
    setServerErrors({});
    setFormError(null);
  }

  function handlePriceChange(priceText: string) {
    update({ priceText });
    setPercentError(null);
    setPercentText(percentTextForPrice(basePrice, priceText));
  }

  function handlePercentChange(text: string) {
    setPercentText(text);
    setServerErrors({});
    setFormError(null);
    const result = priceForPercentText(basePrice, text);
    if (result === null) {
      setPercentError(null);
      return;
    }
    if (result.ok) {
      setPercentError(null);
      setValues((prev) => ({ ...prev, priceText: result.priceText }));
    } else {
      // The price would not match the typed percent, so it is cleared rather than left stale.
      setPercentError(result.message);
      setValues((prev) => ({ ...prev, priceText: "" }));
    }
  }

  function handleSave() {
    setShowErrors(true);
    onRevalidation(true);
    if (Object.keys(errors).length > 0) return;
    startTransition(async () => {
      const result = await updateProductDiscountAction(productId, {
        discountPrice: values.priceText,
        discountEnabled: values.enabled,
        discountStartsAt: values.startsAt,
        discountEndsAt: values.endsAt,
      });
      if (!result.ok) {
        setFormError(result.error);
        setServerErrors((result.fieldErrors ?? {}) as FieldErrors);
        return;
      }
      setShowErrors(false);
      onRevalidation(result.data.revalidationOk);
      toast.success("Diskon berhasil disimpan");
      router.refresh();
    });
  }

  function handleClear() {
    onRevalidation(true);
    startClear(async () => {
      const result = await clearProductDiscountAction(productId);
      if (!result.ok) {
        setFormError(result.error);
        return;
      }
      setValues({ priceText: "", enabled: false, startsAt: "", endsAt: "" });
      setPercentText("");
      setPercentError(null);
      setServerErrors({});
      setShowErrors(false);
      onRevalidation(result.data.revalidationOk);
      toast.success("Diskon dihapus");
      router.refresh();
    });
  }

  return (
    <section className="flex max-w-xl flex-col gap-4 rounded-lg border border-neutral-200 p-4" data-testid="discount-section" aria-labelledby="discount-heading">
      <div className="flex items-center justify-between gap-2">
        <h2 id="discount-heading" className="text-lg font-semibold text-neutral-900">
          Diskon
        </h2>
        <Badge variant={DISCOUNT_STATUS_BADGE_VARIANTS[status]} data-testid="discount-status">
          {DISCOUNT_STATUS_LABELS[status]}
        </Badge>
      </div>

      <Switch label="Aktifkan diskon" checked={values.enabled} onCheckedChange={(enabled) => update({ enabled })} />

      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-neutral-900">Harga normal</span>
        <span className="text-base text-neutral-700 tabular-nums" data-testid="discount-base-price">
          {formatRupiah(basePrice)}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_8rem]">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="discount-price">Harga setelah diskon</Label>
          <Input
            id="discount-price"
            inputMode="numeric"
            value={values.priceText}
            onChange={(event) => handlePriceChange(event.target.value)}
            placeholder="mis. 279.000"
            error={visibleErrors.discountPriceAmount}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="discount-percent">Diskon (%)</Label>
          <Input
            id="discount-percent"
            inputMode="numeric"
            value={percentText}
            onChange={(event) => handlePercentChange(event.target.value)}
            placeholder="mis. 20"
            error={visibleErrors.discountPercent}
          />
        </div>
      </div>
      <p className="text-sm text-neutral-600">
        Isi salah satu, yang lain terisi otomatis. Persen dibulatkan ke bawah ke Rp 1.000.
      </p>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="discount-starts-at">Mulai (WIB)</Label>
          <Input
            id="discount-starts-at"
            type="datetime-local"
            value={values.startsAt}
            onChange={(event) => update({ startsAt: event.target.value })}
            aria-describedby="discount-starts-at-hint"
            error={visibleErrors.discountStartsAt}
          />
          <p id="discount-starts-at-hint" className="text-sm text-neutral-600">
            Kosongkan untuk mulai sekarang.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="discount-ends-at">Selesai (WIB)</Label>
          <Input
            id="discount-ends-at"
            type="datetime-local"
            value={values.endsAt}
            onChange={(event) => update({ endsAt: event.target.value })}
            aria-describedby="discount-ends-at-hint"
            error={visibleErrors.discountEndsAt}
          />
          <p id="discount-ends-at-hint" className="text-sm text-neutral-600">
            Kosongkan jika tanpa batas waktu.
          </p>
        </div>
      </div>

      {formError && Object.keys(serverErrors).length === 0 && (
        <p role="alert" className="text-sm text-danger-700">
          {formError}
        </p>
      )}

      {revalidationWarning}

      <div className="flex justify-end gap-2">
        {hasStoredDiscount && (
          <Button type="button" variant="secondary" onClick={handleClear} loading={clearPending} disabled={pending}>
            Hapus diskon
          </Button>
        )}
        <Button type="button" onClick={handleSave} loading={pending} disabled={clearPending}>
          Simpan diskon
        </Button>
      </div>
    </section>
  );
}

/** Only the "can't read what you typed" messages, shown before the first save attempt. */
function pickFormatErrors(errors: FieldErrors): FieldErrors {
  const formatMessages = new Set<string>([DISCOUNT_PRICE_FORMAT_MESSAGE, DISCOUNT_DATETIME_FORMAT_MESSAGE]);
  const picked: FieldErrors = {};
  for (const [field, message] of Object.entries(errors) as [keyof FieldErrors, string][]) {
    if (formatMessages.has(message) || field === "discountPercent") picked[field] = message;
  }
  return picked;
}
