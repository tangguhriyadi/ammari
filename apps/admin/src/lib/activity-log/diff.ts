import { formatDateTime, formatRupiah } from "@ammari/ui/lib";
import { fieldLabel, isSecretKey, redact } from "./fields";

// The before/after of one audit_log row as display rows (docs/plans/activity-log.md §3): one row
// per field, nested plain objects flattened one level ("Pembelian / Status"), anything deeper or
// any array kept as pretty JSON for a collapsible block. Pure: the page renders, tests assert.

export type DisplayValue =
  | { kind: "empty" }
  | { kind: "redacted" }
  | { kind: "text"; text: string }
  /** Long text or JSON: shown collapsed. */
  | { kind: "long"; text: string; summary: string };

export interface DiffRow {
  key: string;
  label: string;
  before: DisplayValue | null;
  after: DisplayValue | null;
  changed: boolean;
}

export type DiffMode = "change" | "created" | "removed" | "empty";

export interface EntryDiff {
  mode: DiffMode;
  rows: DiffRow[];
}

const LONG_TEXT = 120;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;
/** Money is whole rupiah in a key ending in Amount/Price/Total, or the few bare money names. */
const MONEY_KEY = /(Amount|Price|Total)$/;
const MONEY_KEYS = new Set(["amount", "basePrice", "defaultUnitPrice"]);
/** The value of a whole payload that is not an object (rare: an array or a scalar). */
const WHOLE_VALUE_KEY = "nilai";
const BARE_SCALAR = Symbol("bare scalar");

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMoneyKey(key: string): boolean {
  const last = key.split(".").at(-1) ?? key;
  return MONEY_KEYS.has(last) || MONEY_KEY.test(last);
}

export function displayValue(key: string, value: unknown): DisplayValue {
  const last = key.split(".").at(-1) ?? key;
  if (isSecretKey(last) || value === BARE_SCALAR) return { kind: "redacted" };
  if (value === null || value === undefined || value === "") return { kind: "empty" };
  if (typeof value === "boolean") return { kind: "text", text: value ? "Ya" : "Tidak" };
  if (typeof value === "number") return { kind: "text", text: isMoneyKey(key) && Number.isInteger(value) ? formatRupiah(value) : String(value) };
  if (typeof value === "string") {
    if (ISO_INSTANT.test(value)) {
      const instant = new Date(value);
      if (!Number.isNaN(instant.getTime())) return { kind: "text", text: formatDateTime(instant) };
    }
    if (value.length > LONG_TEXT) return { kind: "long", text: value, summary: `${value.slice(0, 60).trimEnd()}...` };
    return { kind: "text", text: value };
  }
  const json = JSON.stringify(redact(value), null, 2);
  if (Array.isArray(value) && value.length === 0) return { kind: "text", text: "(tidak ada)" };
  if (Array.isArray(value)) return { kind: "long", text: json, summary: `${value.length} item` };
  if (isPlainObject(value) && Object.keys(value).length === 0) return { kind: "text", text: "(tidak ada)" };
  return { kind: "long", text: json, summary: `${Object.keys(value as object).length} field` };
}

/** Top-level keys, and one level of nested plain objects as "parent.child". */
function flatten(payload: unknown): Map<string, unknown> {
  const fields = new Map<string, unknown>();
  if (payload === null || payload === undefined) return fields;
  if (!isPlainObject(payload)) {
    // A bare scalar has no key to judge, so it is never shown; an array is redacted per item.
    fields.set(WHOLE_VALUE_KEY, Array.isArray(payload) ? payload : BARE_SCALAR);
    return fields;
  }
  for (const [key, value] of Object.entries(payload)) {
    if (isPlainObject(value) && Object.keys(value).length > 0 && !isSecretKey(key)) {
      for (const [inner, innerValue] of Object.entries(value)) fields.set(`${key}.${inner}`, innerValue);
    } else {
      fields.set(key, value);
    }
  }
  return fields;
}

function labelFor(key: string): string {
  if (key === WHOLE_VALUE_KEY) return "Nilai";
  return key
    .split(".")
    .map((part) => fieldLabel(part))
    .join(" / ");
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function buildEntryDiff(before: unknown, after: unknown): EntryDiff {
  const hasBefore = before !== null && before !== undefined;
  const hasAfter = after !== null && after !== undefined;
  const mode: DiffMode = hasBefore && hasAfter ? "change" : hasAfter ? "created" : hasBefore ? "removed" : "empty";

  const beforeFields = flatten(before);
  const afterFields = flatten(after);
  const keys = [...afterFields.keys(), ...[...beforeFields.keys()].filter((key) => !afterFields.has(key))];

  const rows = keys.map((key): DiffRow => {
    const beforeValue = beforeFields.get(key);
    const afterValue = afterFields.get(key);
    return {
      key,
      label: labelFor(key),
      before: hasBefore ? displayValue(key, beforeValue) : null,
      after: hasAfter ? displayValue(key, afterValue) : null,
      changed: mode !== "change" || !sameValue(beforeValue, afterValue),
    };
  });
  return { mode, rows };
}
