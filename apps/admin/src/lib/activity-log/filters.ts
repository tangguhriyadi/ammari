import { addCalendarDays, isCalendarDate, jakartaDate } from "@ammari/commerce/jakarta-day";
import { type ActivityArea, isActivityArea } from "./catalog";

// Log Aktivitas filters, all in the URL (docs/plans/activity-log.md §3). Every raw value is
// untrusted: anything invalid falls back to "no filter" (or the default range), never a 500.

/** "Tanpa staf": rows written by the buyer or the system (actor_staff_user_id IS NULL). */
export const NON_STAFF_ACTOR_FILTER = "system";
export const DEFAULT_RANGE_DAYS = 7;
const MAX_QUERY_LENGTH = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ActivityLogFilters {
  /** Inclusive Jakarta calendar dates. */
  from: string;
  to: string;
  /** A staff_users.id, or NON_STAFF_ACTOR_FILTER. */
  actor?: string;
  area?: ActivityArea;
  q?: string;
}

export interface RawActivityLogFilters {
  from?: string;
  to?: string;
  actor?: string;
  area?: string;
  q?: string;
}

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

export function defaultRange(today: string = jakartaDate()): { from: string; to: string } {
  return { from: addCalendarDays(today, -(DEFAULT_RANGE_DAYS - 1)), to: today };
}

export function parseActivityLogFilters(raw: RawActivityLogFilters, today: string = jakartaDate()): ActivityLogFilters {
  const range = defaultRange(today);
  let from = isCalendarDate(raw.from) ? raw.from : range.from;
  let to = isCalendarDate(raw.to) ? raw.to : range.to;
  if (from > to) [from, to] = [to, from];

  const filters: ActivityLogFilters = { from, to };
  const actor = raw.actor?.trim();
  if (actor && (actor === NON_STAFF_ACTOR_FILTER || isUuid(actor))) filters.actor = actor.toLowerCase();
  if (isActivityArea(raw.area)) filters.area = raw.area;
  const q = raw.q?.trim().slice(0, MAX_QUERY_LENGTH);
  if (q) filters.q = q;
  return filters;
}

/** The filters as query params, for pagination links, the CSV link and "Reset" detection. */
export function filterSearchParams(filters: ActivityLogFilters): Record<string, string | undefined> {
  return { from: filters.from, to: filters.to, actor: filters.actor, area: filters.area, q: filters.q };
}

export function toQueryString(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  const query = search.toString();
  return query ? `?${query}` : "";
}

export function isDefaultFilters(filters: ActivityLogFilters, today: string = jakartaDate()): boolean {
  const range = defaultRange(today);
  return filters.from === range.from && filters.to === range.to && !filters.actor && !filters.area && !filters.q;
}
