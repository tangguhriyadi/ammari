import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

// What the admin shows for a channel. `channels.name` is reference data (migration 0014, seed.ts)
// and keeps its stored value; only the label on screen changes here, so the UI stays Indonesian
// ("Website", not "Main site") without touching the row other code may read.

/** Channel id -> label shown instead of the stored `channels.name`. */
export const CHANNEL_DISPLAY_NAMES: Readonly<Record<string, string>> = { web: "Website" };

/** The display name as a SQL expression, for a query that reads the channel's id and name: the
 * columns themselves (a builder query), or raw references such as `ch.id` / `ch.name`. */
export function channelDisplayNameSql(id: AnyPgColumn | SQL, name: AnyPgColumn | SQL): SQL<string> {
  const cases = Object.entries(CHANNEL_DISPLAY_NAMES).map(([channelId, label]) => sql`when ${id} = ${channelId} then ${label}`);
  return sql<string>`(case ${sql.join(cases, sql` `)} else ${name} end)`;
}
