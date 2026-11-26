"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Dialog, Input, Label, Select, Textarea, useToast } from "@ammari/ui";
import { formatNumber } from "@ammari/ui/lib";
import type { BusinessExpenseCategory, BusinessExpenseMethod } from "@ammari/db/schema";
import {
  amountAfterItemChange,
  expenseCategoriesInGroup,
  expenseItemRequirement,
  expenseItemSelectionError,
  expenseItemsOfCategory,
  findExpenseCategory,
  type ExpenseCategoryInfo,
  type ExpenseItemInfo,
} from "@/lib/expense-categories/catalog";
import { expenseChannelRule } from "@/lib/expenses/figures";
import { EXPENSE_CATEGORY_GROUPS, EXPENSE_METHOD_LABELS, MARKETING_CHANNEL_LABELS, MARKETING_CHANNEL_OPTIONS, expenseCategoryHint } from "@/lib/expenses/labels";
import { todayInJakarta } from "@/lib/products/jakarta-date";
import { parseRupiah } from "@/lib/products/money";
import { PROOF_MESSAGES } from "@/lib/supplier-payments/messages";
import { PrivateFileField, type PreparedUpload } from "@/components/supplier-payments/private-file-field";
import { findExpenseProofDuplicatesAction, recordBusinessExpenseAction } from "../actions";

// "Catat biaya" (docs/plans/growth.md §6): date (default today), category, amount, method, the
// channel for an ad or endorse (fixed for Iklan Shopee/TikTok), an optional campaign, a note
// (required for Lainnya) and a REQUIRED proof. The server re-checks every rule; this form only
// gives early feedback. The categories are the catalog's ACTIVE ones (expense_categories), passed
// in by the server page with their ACTIVE items; the client never queries.
//
// Items (docs/plans/expense-master-data.md §3.5, session S4): after the category, "Item biaya"
// lists that category's active items. It is required when there are any and hidden when there are
// none (owner answer D1: no free-text item; details go in Catatan). An item's default amount fills
// Jumlah unless the user typed their own (amountAfterItemChange, D4).

const NOTE_MAX = 500;
const CAMPAIGN_MAX = 120;
const FIELDS = ["expenseDate", "category", "itemId", "amount", "method", "channelId", "campaign", "note", "proof"] as const;
const METHODS = Object.keys(EXPENSE_METHOD_LABELS) as BusinessExpenseMethod[];

type FieldErrors = Partial<Record<(typeof FIELDS)[number], string>>;

export type RecordExpenseCategoryOption = Pick<ExpenseCategoryInfo, "code" | "name" | "kind" | "fixedChannelId">;
export type RecordExpenseItemOption = Pick<ExpenseItemInfo, "id" | "categoryCode" | "name" | "note" | "defaultAmount">;

export function RecordExpenseButton({ categories, items }: { categories: readonly RecordExpenseCategoryOption[]; items: readonly RecordExpenseItemOption[] }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [expenseDate, setExpenseDate] = useState("");
  const [category, setCategory] = useState<BusinessExpenseCategory | "">("");
  const [itemId, setItemId] = useState("");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<BusinessExpenseMethod>("transfer");
  const [channelId, setChannelId] = useState("");
  const [campaign, setCampaign] = useState("");
  const [note, setNote] = useState("");
  const [upload, setUpload] = useState<PreparedUpload | null>(null);
  const [processing, setProcessing] = useState(false);
  const [duplicateOf, setDuplicateOf] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [pending, startTransition] = useTransition();
  // The file whose duplicate lookup may still apply; a late answer for a replaced file is dropped.
  const latestSha = useRef<string | null>(null);

  const selected = category === "" ? undefined : findExpenseCategory(categories, category);
  const rule = selected ? expenseChannelRule(selected) : null;
  const hint = category === "" ? undefined : expenseCategoryHint(category);
  const categoryItems = category === "" ? [] : expenseItemsOfCategory(items, category);
  const itemRequirement = expenseItemRequirement(categoryItems.length);
  const selectedItem = categoryItems.find((item) => item.id === itemId);

  function reset() {
    setExpenseDate(todayInJakarta());
    setCategory("");
    setItemId("");
    setAmount("");
    setMethod("transfer");
    setChannelId("");
    setCampaign("");
    setNote("");
    setUpload(null);
    setDuplicateOf([]);
    latestSha.current = null;
    setError(null);
    setFieldErrors({});
  }

  /** The item select (and a default it filled in) belongs to one category. */
  function changeItem(nextId: string, nextCategory: string) {
    const nextItem = nextId === "" ? undefined : expenseItemsOfCategory(items, nextCategory).find((item) => item.id === nextId);
    setItemId(nextItem?.id ?? "");
    // Computed from the rendered value (one event per render), so the amount error is cleared only
    // when Jumlah actually changes.
    const nextAmount = amountAfterItemChange(amount, selectedItem?.defaultAmount ?? null, nextItem?.defaultAmount ?? null, formatNumber);
    setAmount(nextAmount);
    setFieldErrors((current) => ({ ...current, itemId: undefined, ...(nextAmount !== amount ? { amount: undefined } : {}) }));
  }

  function handleCategory(next: BusinessExpenseCategory | "") {
    setCategory(next);
    changeItem("", next);
    const nextCategory = next === "" ? undefined : findExpenseCategory(categories, next);
    const nextRule = nextCategory ? expenseChannelRule(nextCategory) : null;
    // A fixed ad shows its own channel; an operating cost has none and no campaign.
    setChannelId(nextRule?.kind === "fixed" ? nextRule.channelId : "");
    if (nextRule?.kind === "none" || nextRule === null) setCampaign("");
    // Marketplace ads (the fixed-channel ones: Iklan Shopee/TikTok) are usually paid from the seller
    // balance; leaving them restores the default unless the user picked a method themselves.
    const marketplaceAd = nextRule?.kind === "fixed";
    setMethod((current) => (marketplaceAd && current === "transfer" ? "platform_balance" : !marketplaceAd && current === "platform_balance" ? "transfer" : current));
    setFieldErrors((current) => ({ ...current, category: undefined, channelId: undefined, campaign: undefined, note: undefined }));
  }

  function handleUpload(value: PreparedUpload | null) {
    setUpload(value);
    setDuplicateOf([]);
    setFieldErrors((current) => ({ ...current, proof: undefined }));
    latestSha.current = value?.sha256 ?? null;
    if (!value?.sha256) return;
    const sha256 = value.sha256;
    // Advisory only (plan §5 step 4): a lookup failure just means no warning.
    void findExpenseProofDuplicatesAction({ sha256 })
      .then((result) => {
        if (result.ok && latestSha.current === sha256) setDuplicateOf(result.data.documentNos);
      })
      .catch(() => undefined);
  }

  function handleConfirm() {
    if (processing) return;
    setError(null);
    const early: FieldErrors = {};
    if (category === "") early.category = "Pilih kategori.";
    const itemError = category === "" ? null : expenseItemSelectionError(categoryItems.length, itemId === "" ? null : itemId);
    if (itemError) early.itemId = itemError;
    if (expenseDate === "") early.expenseDate = "Tanggal bayar tidak valid.";
    const parsedAmount = parseRupiah(amount);
    if (parsedAmount === null || parsedAmount <= 0) early.amount = "Jumlah harus bilangan bulat lebih dari 0, maksimal Rp1.000.000.000.";
    if (expenseDate > todayInJakarta()) early.expenseDate = "Tanggal bayar tidak boleh di masa depan.";
    if (category === "other" && note.trim() === "") early.note = "Untuk kategori Lainnya, tulis di catatan biaya apa ini.";
    if (!upload) early.proof = PROOF_MESSAGES.missing;
    if (Object.keys(early).length > 0 || !upload) {
      setFieldErrors(early);
      return;
    }
    setFieldErrors({});
    const formData = new FormData();
    formData.set("expenseDate", expenseDate);
    formData.set("category", category);
    formData.set("itemId", itemId);
    formData.set("amount", amount);
    formData.set("method", method);
    formData.set("channelId", channelId);
    formData.set("campaign", campaign);
    formData.set("note", note);
    formData.set("proof", upload.file, upload.file.name);
    startTransition(async () => {
      try {
        const result = await recordBusinessExpenseAction(formData);
        if (!result.ok) {
          // A field's own error shows under that field; anything else under the form.
          const shown: readonly string[] = FIELDS;
          // An item error while the item field is hidden means the category gained items after
          // this page loaded: say so under the form, where it is visible.
          if (result.fieldErrors?.itemId && itemRequirement === "hidden") setError("Kategori ini sekarang punya daftar item. Muat ulang halaman, lalu pilih item biaya.");
          else if (result.fieldErrors && Object.keys(result.fieldErrors).every((key) => shown.includes(key))) setFieldErrors(result.fieldErrors as FieldErrors);
          else setError(result.error);
          return;
        }
        setOpen(false);
        toast.success(`Biaya ${result.data.expenseNo} dicatat.`);
        router.refresh();
      } catch {
        // A network drop or a body over the server's limit never reaches runAction.
        setError("Gagal mengunggah bukti. Periksa koneksi lalu coba lagi.");
      }
    });
  }

  const busy = pending || processing;

  return (
    <>
      <Button
        type="button"
        onClick={() => {
          reset();
          setOpen(true);
        }}
      >
        Catat biaya
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next);
        }}
        title="Catat biaya"
        description="Biaya iklan atau operasional yang sudah dibayar, dengan bukti."
        confirmLabel="Simpan biaya"
        onConfirm={handleConfirm}
        // `busy`, not just `pending`: the dialog must not be dismissed while a photo is being prepared.
        loading={busy}
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="expense-date" required>
              Tanggal bayar
            </Label>
            <Input
              id="expense-date"
              type="date"
              value={expenseDate}
              max={todayInJakarta()}
              onChange={(event) => setExpenseDate(event.target.value)}
              error={fieldErrors.expenseDate}
              disabled={pending}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="expense-category" required>
              Kategori
            </Label>
            <Select
              id="expense-category"
              value={category}
              onChange={(event) => handleCategory(event.target.value as BusinessExpenseCategory | "")}
              error={fieldErrors.category}
              disabled={pending}
              aria-describedby={hint ? "expense-category-hint" : undefined}
            >
              <option value="">Pilih kategori</option>
              {EXPENSE_CATEGORY_GROUPS.map((group) => {
                const inGroup = expenseCategoriesInGroup(categories, group.key);
                if (inGroup.length === 0) return null;
                return (
                  <optgroup key={group.key} label={group.label}>
                    {inGroup.map((option) => (
                      <option key={option.code} value={option.code}>
                        {option.name}
                      </option>
                    ))}
                  </optgroup>
                );
              })}
            </Select>
            {hint && (
              <p id="expense-category-hint" className="text-sm text-neutral-600">
                {hint}
              </p>
            )}
          </div>
          {itemRequirement === "required" && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="expense-item" required>
                Item biaya
              </Label>
              <Select
                id="expense-item"
                value={itemId}
                onChange={(event) => changeItem(event.target.value, category)}
                error={fieldErrors.itemId}
                disabled={pending}
                aria-describedby={selectedItem?.note ? "expense-item-hint" : undefined}
              >
                <option value="">Pilih item</option>
                {categoryItems.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </Select>
              {selectedItem?.note && (
                <p id="expense-item-hint" className="text-sm text-neutral-600">
                  {selectedItem.note}
                </p>
              )}
              {/* A new tab, so the half-filled form (and the chosen proof) is not lost. The list
                  here refreshes after the dialog closes and the page reloads. */}
              <p className="text-sm text-neutral-600">
                Item tidak ada di daftar? Tambahkan di{" "}
                <Link
                  href={`/expense-categories/${encodeURIComponent(category)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-brand hover:underline"
                >
                  Data Master Kategori Biaya (tab baru)
                </Link>
                , lalu muat ulang halaman ini.
              </p>
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="expense-amount" required>
              Jumlah
            </Label>
            <Input
              id="expense-amount"
              inputMode="numeric"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="0"
              error={fieldErrors.amount}
              disabled={pending}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="expense-method" required>
              Metode
            </Label>
            <Select
              id="expense-method"
              value={method}
              onChange={(event) => setMethod(event.target.value as BusinessExpenseMethod)}
              error={fieldErrors.method}
              disabled={pending}
            >
              {METHODS.map((key) => (
                <option key={key} value={key}>
                  {EXPENSE_METHOD_LABELS[key]}
                </option>
              ))}
            </Select>
          </div>
          {rule && rule.kind !== "none" && (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="expense-channel">Kanal</Label>
                <Select
                  id="expense-channel"
                  value={channelId}
                  onChange={(event) => setChannelId(event.target.value)}
                  error={fieldErrors.channelId}
                  // Iklan Shopee/TikTok always belong to their own channel.
                  disabled={pending || rule.kind === "fixed"}
                >
                  {rule.kind === "optional" && <option value="">Tanpa kanal</option>}
                  {MARKETING_CHANNEL_OPTIONS.map((key) => (
                    <option key={key} value={key}>
                      {MARKETING_CHANNEL_LABELS[key]}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="expense-campaign">Kampanye</Label>
                <Input
                  id="expense-campaign"
                  value={campaign}
                  onChange={(event) => setCampaign(event.target.value)}
                  maxLength={CAMPAIGN_MAX}
                  placeholder="Opsional, mis. Promo 11.11"
                  error={fieldErrors.campaign}
                  disabled={pending}
                />
              </div>
            </>
          )}
          <PrivateFileField
            id="expense-proof"
            label="Bukti bayar"
            hint="Foto struk/nota, screenshot transfer atau tagihan iklan (JPG, PNG, WebP), atau PDF. Maksimal 10 MB."
            value={upload}
            onChange={handleUpload}
            onProcessingChange={setProcessing}
            error={fieldErrors.proof}
            disabled={pending}
          />
          {duplicateOf.length > 0 && (
            <p className="rounded-md bg-warning-50 p-2 text-sm text-warning-700" data-testid="duplicate-proof-warning">
              Bukti ini sudah dipakai untuk {duplicateOf.join(", ")}. Pastikan ini bukan pembayaran yang sama.
            </p>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="expense-note" required={category === "other"}>
              Catatan
            </Label>
            <Textarea
              id="expense-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={2}
              maxLength={NOTE_MAX}
              placeholder={category === "other" ? "Wajib, mis. servis mesin jahit" : "Opsional"}
              error={fieldErrors.note}
              disabled={pending}
            />
          </div>
          {pending && (
            <p className="text-sm text-neutral-600" aria-live="polite">
              Mengunggah dan menyimpan bukti...
            </p>
          )}
          {error && (
            <p role="alert" className="text-base text-danger-700">
              {error}
            </p>
          )}
        </div>
      </Dialog>
    </>
  );
}
