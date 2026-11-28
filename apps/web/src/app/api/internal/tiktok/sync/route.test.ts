import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { testDb, withRollback, type TestTx } from "@ammari/db/test-utils";
import { withExclusiveRun } from "@ammari/commerce/maintenance";
import type { TikTokSyncSummary } from "@ammari/commerce/tiktok";

// docs/plans/tiktok-shop-integration.md §9, T4: the TikTok sync cron route. The run itself is tested
// against a real database in packages/commerce (src/tiktok/sync.test.ts); here: the cron auth gate,
// "not configured" (503, no values logged), the shared cron lock (skipped), and the answer codes
// (429 rate limited, 502 unavailable, 500 failed or reconnect needed, 200 otherwise). No TikTok call.

let currentDb: TestTx | null = null;
vi.mock("@/lib/db", () => ({
  get defaultDb() {
    if (!currentDb) throw new Error("no test transaction");
    return currentDb;
  },
}));

const { runTikTokSyncMock } = vi.hoisted(() => ({ runTikTokSyncMock: vi.fn() }));
vi.mock("@ammari/commerce/tiktok", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ammari/commerce/tiktok")>();
  return { ...actual, runTikTokSync: runTikTokSyncMock };
});

const route = await import("./route");

const SECRET = randomBytes(24).toString("hex");
const APP_SECRET = `dummy-secret-${randomBytes(8).toString("hex")}`;
const ENV_NAMES = ["TIKTOK_APP_KEY", "TIKTOK_APP_SECRET", "TIKTOK_TOKEN_ENC_KEY_V1", "TIKTOK_TOKEN_ENC_KEY_CURRENT", "TIKTOK_PROVIDER"];

function afterSales(overrides: Partial<TikTokSyncSummary["afterSales"]> = {}): TikTokSyncSummary["afterSales"] {
  const poll = { slices: 1, slicesDone: 1, pages: 1, caughtUp: true, windowEnd: null };
  return { poll: { return: poll, cancellation: poll }, fetched: 0, snapshotsInserted: 0, replays: 0, conflicts: 0, invalid: 0, storeFailed: 0, applied: 0, unchanged: 0, refundsRecorded: 0, busy: 0, failed: 0, notFound: 0, rechecked: 0, recheckIncomplete: false, problems: [], ...overrides };
}

function summary(overrides: Partial<TikTokSyncSummary> = {}): TikTokSyncSummary {
  return {
    connection: "active",
    connectionEvents: { processed: 0, notApplied: 0 },
    tokenRefresh: "not_due",
    inbox: { claimed: 0, processed: 0, ignored: 0, retried: 0, failed: 0, released: 0 },
    poll: { slices: 1, slicesDone: 1, pages: 1, orderIds: 0, caughtUp: true, windowEnd: null },
    orders: { fetched: 0, snapshotsInserted: 0, replays: 0, conflicts: 0, projectionsAdvanced: 0, missing: 0, invalid: 0, storeFailed: 0, autoMapped: 0 },
    apply: { enabled: false, created: 0, updated: 0, unchanged: 0, held: 0, skipped: 0, busy: 0, failed: 0, rechecked: 0, recheckIncomplete: false, notFound: 0, problems: [] },
    afterSales: afterSales(),
    budgetExhausted: false,
    error: null,
    problems: [],
    ...overrides,
  };
}

beforeEach(() => {
  process.env.INTERNAL_CRON_SECRET = SECRET;
  Object.assign(process.env, { TIKTOK_APP_KEY: "dummyappkey", TIKTOK_APP_SECRET: APP_SECRET, TIKTOK_TOKEN_ENC_KEY_V1: Buffer.alloc(32, 3).toString("base64"), TIKTOK_TOKEN_ENC_KEY_CURRENT: "1" });
  runTikTokSyncMock.mockReset();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => {
  delete process.env.INTERNAL_CRON_SECRET;
  for (const name of ENV_NAMES) delete process.env[name];
  currentDb = null;
  vi.restoreAllMocks();
});

async function inRollback(fn: () => Promise<void>): Promise<void> {
  await withRollback(async (tx) => {
    currentDb = tx;
    await fn();
  });
}

function call(headers: Record<string, string> = { authorization: `Bearer ${SECRET}` }) {
  return route.POST(new Request("http://web:3000/api/internal/tiktok/sync", { method: "POST", headers }));
}

describe("POST /api/internal/tiktok/sync", () => {
  test("refused without the cron secret, with a wrong one, or through a proxy; never runs", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect((await call({ authorization: "Bearer wrong" })).status).toBe(401);
    expect((await call({ authorization: `Bearer ${SECRET}`, "x-ammari-proxy": "caddy" })).status).toBe(404);
    expect(runTikTokSyncMock).not.toHaveBeenCalled();
  });

  test("not configured: 503, the log names variables, never values", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    delete process.env.TIKTOK_APP_KEY;
    const response = await call();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "tiktok not configured" });
    expect(JSON.stringify(errors.mock.calls)).toContain("TIKTOK_APP_KEY");
    expect(JSON.stringify(errors.mock.calls)).not.toContain(APP_SECRET);
    expect(runTikTokSyncMock).not.toHaveBeenCalled();
  });

  test("skipped (200) while another cron job holds the shared cron lock", async () => {
    await inRollback(async () => {
      let release: () => void = () => undefined;
      const blocker = new Promise<void>((resolve) => (release = resolve));
      const other = withExclusiveRun(testDb, "paymentSweep", () => blocker);
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        const response = await call();
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ skipped: "running" });
        expect(runTikTokSyncMock).not.toHaveBeenCalled();
      } finally {
        release();
        await other;
      }
    });
  });

  test("answer codes: 200 done or not connected or out of budget, 429 rate limited, 502 unavailable, 500 failed or reconnect needed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const cases: [TikTokSyncSummary, number][] = [
      [summary(), 200],
      [summary({ budgetExhausted: true }), 200],
      [summary({ error: { kind: "rate_limited", code: "rate_limited:36009002" } }), 429],
      [summary({ error: { kind: "unavailable", code: "unavailable" } }), 502],
      [summary({ error: { kind: "network", code: "network" } }), 502],
      [summary({ error: { kind: "api", code: "api:12345" } }), 500],
      [summary({ connection: "reauth_required" }), 500],
      // T5: a held or busy apply is not a failure; an apply that threw is (retried every run).
      [summary({ apply: { enabled: true, created: 0, updated: 0, unchanged: 0, held: 3, skipped: 0, busy: 1, failed: 0, rechecked: 4, recheckIncomplete: false, notFound: 0, problems: [] } }), 200],
      [summary({ apply: { enabled: true, created: 0, updated: 0, unchanged: 0, held: 0, skipped: 0, busy: 0, failed: 1, rechecked: 1, recheckIncomplete: false, notFound: 0, problems: [{ id: "o-1", kind: "failed", code: "sqlstate:23505" }] } }), 500],
      // T6: a return/cancellation apply that threw is a failure too; a busy one is not.
      [summary({ afterSales: afterSales({ busy: 1 }) }), 200],
      [summary({ afterSales: afterSales({ failed: 1, problems: [{ id: "return:r-1", kind: "failed", code: "sqlstate:23505" }] }) }), 500],
      [summary({ error: { kind: "incomplete", code: "order_missing" }, problems: [{ id: "o-1", problem: "order_missing" }] }), 500],
    ];
    for (const [value, status] of cases) {
      await inRollback(async () => {
        runTikTokSyncMock.mockResolvedValueOnce(value);
        const response = await call();
        expect(response.status).toBe(status);
        expect(await response.json()).toMatchObject({ connection: value.connection });
      });
    }
    await inRollback(async () => {
      runTikTokSyncMock.mockResolvedValueOnce(summary({ connection: "not_connected" }));
      const response = await call();
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ skipped: "not_connected" });
    });
  });

  test("a run that throws answers 500 without the error text", async () => {
    await inRollback(async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      runTikTokSyncMock.mockRejectedValueOnce(new Error('relation "secret_table" does not exist'));
      const response = await call();
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "sync failed" });
    });
  });
});
