import "server-only";

// One allowlist per payload type, applied before anything touches the database
// (docs/plans/tiktok-shop-integration.md §6). Fields not on the list are dropped, including any
// field TikTok adds later. This file holds only the generic mechanism; the per-payload lists
// (orders, finance, webhook) are written with the sessions that store those payloads (T3, T4, T7).
//
// A spec maps each kept key to:
//   - `true`: keep a scalar (string, number, boolean, null) or an array of scalars. An object or an
//     array containing an object under a `true` key is dropped entirely, so a nested buyer object
//     can never slip through a key that was only meant for a scalar.
//   - a nested spec: keep that object, filtered by the nested spec.
//   - `[spec]`: keep an array of objects, each filtered by `spec`; non-object elements are dropped.

export type AllowlistSpec = { readonly [key: string]: AllowlistRule };
export type AllowlistRule = true | AllowlistSpec | readonly [AllowlistSpec];

type Scalar = string | number | boolean | null;
export type AllowlistedValue = Scalar | Scalar[] | AllowlistedObject | AllowlistedObject[];
export interface AllowlistedObject {
  [key: string]: AllowlistedValue;
}

function isScalar(value: unknown): value is Scalar {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function applyRule(value: unknown, rule: AllowlistRule): AllowlistedValue | undefined {
  if (rule === true) {
    if (isScalar(value)) return value;
    if (Array.isArray(value) && value.every(isScalar)) return [...value];
    return undefined;
  }
  if (Array.isArray(rule)) {
    if (!Array.isArray(value)) return undefined;
    const itemSpec = (rule as readonly [AllowlistSpec])[0];
    return value.filter(isPlainObject).map((item) => applyAllowlist(item, itemSpec));
  }
  return isPlainObject(value) ? applyAllowlist(value, rule as AllowlistSpec) : undefined;
}

/** A copy of `value` with only the allowlisted fields. Never mutates its input. A non-object input
 * gives an empty object. Keys are own enumerable properties only (`Object.hasOwn`), so a prototype
 * key named on the list is never read. */
export function applyAllowlist(value: unknown, spec: AllowlistSpec): AllowlistedObject {
  const result: AllowlistedObject = {};
  if (!isPlainObject(value)) return result;
  for (const key of Object.keys(spec)) {
    if (!Object.hasOwn(value, key)) continue;
    const kept = applyRule(value[key], spec[key]!);
    // defineProperty, not assignment: a key like `__proto__` becomes a plain own property.
    if (kept !== undefined) Object.defineProperty(result, key, { value: kept, enumerable: true, writable: true, configurable: true });
  }
  return result;
}
