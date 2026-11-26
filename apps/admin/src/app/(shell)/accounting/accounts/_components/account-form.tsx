"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  ACCOUNT_CODE_CLASS_TYPES,
  ACCOUNT_TYPES,
  CASH_BANK_ACCOUNT_CODE_PATTERN,
  type AccountNormalBalance,
  type AccountType,
  type CashFlowGroup,
} from "@ammari/db/schema";
import { Button, Checkbox, Input, Label, Select, useToast } from "@ammari/ui";
import { ACCOUNT_TYPE_LABELS, CASH_FLOW_GROUP_LABELS, NORMAL_BALANCE_LABELS } from "@/lib/accounting/labels";
import { createAccountAction, updateAccountAction } from "../actions";

// Add or edit an account (Data Master Akun, Session 3). The server applies every rule
// (lib/accounting/account-input.ts) and the database refuses the same; this form only shows the
// fields that apply: a sub-account takes its parent's type, bank fields only on a postable Kas &
// Bank account (1-11xx, 1-12xx, D-17), the cash-flow group only where it is a choice.

const CASH_BANK = new RegExp(CASH_BANK_ACCOUNT_CODE_PATTERN);
const CHOSEN_CASH_FLOW_GROUPS: CashFlowGroup[] = ["operating", "investing", "financing", "cash"];
const DEBIT_NORMAL: AccountType[] = ["asset", "contra_revenue", "cogs", "expense", "other_expense", "tax"];

export interface HeaderOption {
  code: string;
  name: string;
  type: AccountType;
  /** The first free code under it, if any. */
  suggestedCode: string | null;
}

export type AccountFormProps =
  | { mode: "create"; headers: HeaderOption[]; initialParentCode: string | null }
  | {
      mode: "edit";
      code: string;
      type: AccountType;
      isHeader: boolean;
      isSystem: boolean;
      headers: HeaderOption[];
      initialValues: { name: string; parentCode: string | null; cashFlowGroup: CashFlowGroup; bankName: string; accountNoLast4: string };
    };

function typesForCode(code: string): readonly AccountType[] {
  return (ACCOUNT_CODE_CLASS_TYPES as Record<string, readonly AccountType[]>)[code.charAt(0)] ?? ACCOUNT_TYPES;
}

export function AccountForm(props: AccountFormProps) {
  const router = useRouter();
  const toast = useToast();
  const editing = props.mode === "edit";
  const initialParent = editing ? props.initialValues.parentCode : props.initialParentCode;
  const initialHeader = props.headers.find((header) => header.code === initialParent) ?? null;

  const [parentCode, setParentCode] = useState<string>(initialParent ?? "");
  const [code, setCode] = useState<string>(editing ? props.code : (initialHeader?.suggestedCode ?? ""));
  const [name, setName] = useState(editing ? props.initialValues.name : "");
  const [type, setType] = useState<AccountType | "">(editing ? props.type : (initialHeader?.type ?? ""));
  const [normalBalance, setNormalBalance] = useState<AccountNormalBalance | "">(
    editing ? "debit" : initialHeader ? (DEBIT_NORMAL.includes(initialHeader.type) ? "debit" : "credit") : "",
  );
  const [isHeader, setIsHeader] = useState(editing ? props.isHeader : false);
  const [cashFlowGroup, setCashFlowGroup] = useState<CashFlowGroup | "">(
    editing ? (CHOSEN_CASH_FLOW_GROUPS.includes(props.initialValues.cashFlowGroup) ? props.initialValues.cashFlowGroup : "") : "operating",
  );
  const [bankName, setBankName] = useState(editing ? props.initialValues.bankName : "");
  const [accountNoLast4, setAccountNoLast4] = useState(editing ? props.initialValues.accountNoLast4 : "");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, startTransition] = useTransition();
  const [created, setCreated] = useState(false);

  const parent = props.headers.find((header) => header.code === parentCode) ?? null;
  const effectiveType = parent?.type ?? type;
  const isCashBank = CASH_BANK.test(code.trim()) && !isHeader;
  const cashFlowIsChoice = !isHeader && !CASH_BANK.test(code.trim()) && !(editing && props.isSystem);
  // On edit the page passes only headers of the account's own type that are not the account or
  // one of its descendants (plus its current parent, even if that one is inactive).
  const parentOptions = props.headers;

  function chooseParent(next: string) {
    setParentCode(next);
    if (editing) return;
    const header = props.headers.find((candidate) => candidate.code === next);
    if (header) {
      setType(header.type);
      setNormalBalance(DEBIT_NORMAL.includes(header.type) ? "debit" : "credit");
      setCode(header.suggestedCode ?? "");
    }
  }

  function changeCode(next: string) {
    setCode(next);
    // A type the new code's class doesn't allow is cleared, so the select never shows blank while
    // the form still holds the old type.
    if (!parent && type && !typesForCode(next.trim()).includes(type)) setType("");
  }

  function chooseType(next: AccountType | "") {
    setType(next);
    if (next) setNormalBalance(DEBIT_NORMAL.includes(next) ? "debit" : "credit");
  }

  function handleSubmit() {
    if (saving || created) return;
    setError(null);
    setFieldErrors({});
    startTransition(async () => {
      const shared = {
        name,
        parentCode: parentCode || null,
        cashFlowGroup: cashFlowIsChoice && cashFlowGroup ? cashFlowGroup : undefined,
        bankName: isCashBank ? bankName : null,
        accountNoLast4: isCashBank ? accountNoLast4 : null,
      };
      if (props.mode === "create") {
        if (!effectiveType) {
          setFieldErrors({ type: "Pilih jenis akun." });
          return;
        }
        const result = await createAccountAction({
          ...shared,
          code,
          type: effectiveType,
          normalBalance: normalBalance || (DEBIT_NORMAL.includes(effectiveType) ? "debit" : "credit"),
          isHeader,
        });
        if (!result.ok) {
          setError(result.error);
          setFieldErrors(result.fieldErrors ?? {});
          return;
        }
        setCreated(true);
        toast.success("Akun berhasil ditambahkan");
        router.push(`/accounting/accounts/${result.data.code}`);
        return;
      }
      const result = await updateAccountAction(props.code, shared);
      if (!result.ok) {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }
      toast.success("Perubahan berhasil disimpan");
      router.refresh();
    });
  }

  return (
    <form
      className="flex max-w-xl flex-col gap-4"
      aria-label={editing ? "Ubah akun" : "Tambah akun"}
      onSubmit={(event) => {
        event.preventDefault();
        handleSubmit();
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="account-parent">Akun induk</Label>
        <Select id="account-parent" value={parentCode} onChange={(event) => chooseParent(event.target.value)} error={fieldErrors.parentCode} disabled={saving}>
          <option value="">Tanpa induk</option>
          {parentOptions.map((header) => (
            <option key={header.code} value={header.code}>
              {header.code} {header.name}
            </option>
          ))}
        </Select>
        <p className="text-sm text-neutral-600">Hanya akun kelompok yang bisa menjadi induk. Sub-akun ikut jenis akun induknya.</p>
      </div>

      {props.mode === "create" ? (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-code" required>
              Kode akun
            </Label>
            <Input
              id="account-code"
              value={code}
              onChange={(event) => changeCode(event.target.value)}
              placeholder="mis. 1-1202"
              maxLength={6}
              inputMode="numeric"
              error={fieldErrors.code}
              required
              disabled={saving}
            />
            <p className="text-sm text-neutral-600">Format 1-2345. Digit pertama menentukan jenis akun. Tidak bisa diubah setelah disimpan.</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-type" required>
              Jenis
            </Label>
            <Select
              id="account-type"
              value={effectiveType}
              onChange={(event) => chooseType(event.target.value as AccountType | "")}
              error={fieldErrors.type}
              disabled={saving || parent !== null}
            >
              <option value="">Pilih jenis</option>
              {(code.trim() ? typesForCode(code.trim()) : ACCOUNT_TYPES).map((option) => (
                <option key={option} value={option}>
                  {ACCOUNT_TYPE_LABELS[option]}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-normal-balance" required>
              Saldo normal
            </Label>
            <Select
              id="account-normal-balance"
              value={normalBalance}
              onChange={(event) => setNormalBalance(event.target.value as AccountNormalBalance | "")}
              error={fieldErrors.normalBalance}
              disabled={saving}
            >
              <option value="">Pilih saldo normal</option>
              {(["debit", "credit"] as const).map((option) => (
                <option key={option} value={option}>
                  {NORMAL_BALANCE_LABELS[option]}
                </option>
              ))}
            </Select>
            <p className="text-sm text-neutral-600">Biasanya mengikuti jenis. Akun lawan, mis. akumulasi penyusutan, memakai sisi sebaliknya.</p>
          </div>
          <Checkbox
            id="account-is-header"
            label="Akun kelompok (tidak bisa dijurnal, hanya mengelompokkan sub-akun)"
            checked={isHeader}
            onChange={(event) => setIsHeader(event.target.checked)}
            disabled={saving}
          />
        </>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="account-name" required>
          Nama akun
        </Label>
        <Input
          id="account-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="mis. Bank cadangan"
          maxLength={80}
          error={fieldErrors.name}
          required
          disabled={saving}
        />
      </div>

      {cashFlowIsChoice && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="account-cash-flow" required>
            Kelompok arus kas
          </Label>
          <Select
            id="account-cash-flow"
            value={cashFlowGroup}
            onChange={(event) => setCashFlowGroup(event.target.value as CashFlowGroup | "")}
            error={fieldErrors.cashFlowGroup}
            disabled={saving}
          >
            {!CHOSEN_CASH_FLOW_GROUPS.includes(cashFlowGroup as CashFlowGroup) && <option value="">Pilih kelompok arus kas</option>}
            {CHOSEN_CASH_FLOW_GROUPS.map((option) => (
              <option key={option} value={option}>
                {CASH_FLOW_GROUP_LABELS[option]}
              </option>
            ))}
          </Select>
        </div>
      )}

      {isCashBank && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-bank-name">Nama bank</Label>
            <Input
              id="account-bank-name"
              value={bankName}
              onChange={(event) => setBankName(event.target.value)}
              placeholder="mis. BCA"
              maxLength={60}
              error={fieldErrors.bankName}
              disabled={saving}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-last4">4 digit terakhir rekening</Label>
            <Input
              id="account-last4"
              value={accountNoLast4}
              onChange={(event) => setAccountNoLast4(event.target.value)}
              placeholder="mis. 1234"
              maxLength={4}
              inputMode="numeric"
              error={fieldErrors.accountNoLast4}
              disabled={saving}
            />
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-danger-700">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={saving}>
          {editing ? "Simpan perubahan" : "Simpan akun"}
        </Button>
        <Link href="/accounting/accounts" className="text-base font-medium text-brand hover:underline">
          Kembali ke daftar
        </Link>
      </div>
    </form>
  );
}
