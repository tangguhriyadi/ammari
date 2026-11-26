"use client";

import { Input, Label, Select } from "@ammari/ui";
import { MANUAL_ORDER_PAYMENT_METHODS, type ManualOrderPaymentMethod } from "@ammari/db/schema";
import {
  MANUAL_PAYMENT_MESSAGES,
  MANUAL_PAYMENT_METHOD_LABELS,
  accountAfterMethodChange,
  manualPaymentDateProblem,
  type ManualPaymentOptions,
} from "@/lib/orders/manual-payment-input";

// Cara bayar, rekening tujuan, tanggal bayar (D-3, docs/plans/accounting.md Session 6). Shared by the
// order form, "Siap Kirim" on an order waiting for payment, and "Isi cara bayar" on the order page.
// The forms using it set noValidate: the date's `max` is a picker hint, and every message comes from
// manualPaymentFromDraft (and the server), in Indonesian.

export interface ManualPaymentDraft {
  method: ManualOrderPaymentMethod | "";
  cashAccountCode: string;
  paidOn: string;
}

export function emptyManualPaymentDraft(paidOn = ""): ManualPaymentDraft {
  return { method: "", cashAccountCode: "", paidOn };
}

/** The draft as the action's input, or the first problem's message (the server checks again). */
export function manualPaymentFromDraft(
  draft: ManualPaymentDraft,
  maxDate: string,
): { ok: true; payment: { method: ManualOrderPaymentMethod; cashAccountCode: string; paidOn: string } } | { ok: false; error: string } {
  if (!draft.method) return { ok: false, error: MANUAL_PAYMENT_MESSAGES.method };
  if (!draft.cashAccountCode) return { ok: false, error: MANUAL_PAYMENT_MESSAGES.account };
  if (!draft.paidOn) return { ok: false, error: MANUAL_PAYMENT_MESSAGES.paidOn };
  const dateProblem = manualPaymentDateProblem(draft.paidOn, maxDate);
  if (dateProblem) return { ok: false, error: dateProblem };
  return { ok: true, payment: { method: draft.method, cashAccountCode: draft.cashAccountCode, paidOn: draft.paidOn } };
}

export function ManualPaymentFields({
  idPrefix,
  value,
  onChange,
  options,
  maxDate,
  layout = "row",
  disabled = false,
  autoFocus = false,
}: {
  idPrefix: string;
  value: ManualPaymentDraft;
  onChange: (next: ManualPaymentDraft) => void;
  options: ManualPaymentOptions;
  /** Today in Jakarta: the money cannot have come in later. */
  maxDate: string;
  /** "row": three columns from sm (full-width forms); "stack": one column (a narrow card). */
  layout?: "row" | "stack";
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <div className={`grid grid-cols-1 gap-3 ${layout === "row" ? "sm:grid-cols-3" : ""}`}>
      <div>
        <Label htmlFor={`${idPrefix}-method`} required>
          Cara bayar
        </Label>
        <Select
          id={`${idPrefix}-method`}
          value={value.method}
          disabled={disabled}
          autoFocus={autoFocus}
          aria-required="true"
          onChange={(event) => {
            const method = event.target.value as ManualOrderPaymentMethod | "";
            // Picking a method preselects its mapped account (D-17, D-18); staff may change it.
            onChange({ ...value, method, cashAccountCode: accountAfterMethodChange(value, method, options) });
          }}
        >
          <option value="">Pilih cara bayar</option>
          {MANUAL_ORDER_PAYMENT_METHODS.map((method) => (
            <option key={method} value={method}>
              {MANUAL_PAYMENT_METHOD_LABELS[method]}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor={`${idPrefix}-account`} required>
          Uang masuk ke
        </Label>
        <Select
          id={`${idPrefix}-account`}
          value={value.cashAccountCode}
          disabled={disabled}
          aria-required="true"
          onChange={(event) => onChange({ ...value, cashAccountCode: event.target.value })}
        >
          <option value="">Pilih rekening</option>
          {options.accounts.map((account) => (
            <option key={account.code} value={account.code}>
              {account.name}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor={`${idPrefix}-paid-on`} required>
          Tanggal bayar
        </Label>
        <Input
          id={`${idPrefix}-paid-on`}
          type="date"
          max={maxDate}
          value={value.paidOn}
          disabled={disabled}
          aria-required="true"
          onChange={(event) => onChange({ ...value, paidOn: event.target.value })}
        />
      </div>
    </div>
  );
}
