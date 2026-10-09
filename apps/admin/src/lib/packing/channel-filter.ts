import type { ChannelId } from "@ammari/db/schema";

/** `/packing`'s own `?channel=` parsing — pulled out of page.tsx specifically so it's directly
 * unit-testable (a Server Component page itself isn't a plain function callable from a test
 * without mocking its whole dependency chain). Returns `undefined` ("Semua"/no filter) unless
 * `rawChannel` exactly matches one of the channels that actually exist — an unknown/stale/typo'd
 * value is treated exactly like "no filter selected" rather than silently matching nothing. */
export function resolvePackingChannelFilter(
  rawChannel: string | undefined,
  channels: readonly { id: ChannelId }[],
): ChannelId | undefined {
  const match = channels.find((c) => c.id === rawChannel);
  return match?.id;
}
