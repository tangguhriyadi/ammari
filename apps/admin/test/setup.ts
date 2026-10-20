import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

// Server actions call `revalidatePath` (via lib/admin-revalidate.ts) after a successful write.
// The real one throws outside a Next request ("static generation store missing"), and a unit
// test calling an action directly has no request, so it's a no-op spy here.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn(), updateTag: vi.fn(), refresh: vi.fn() }));

// RTL's auto-cleanup hooks into a GLOBAL `afterEach`, which this repo doesn't enable
// (vitest.config.mts has no `test.globals: true`, matching packages/ui's convention of explicit
// `import { ... } from "vitest"`) — so it's wired up explicitly here instead.
afterEach(() => {
  cleanup();
});
