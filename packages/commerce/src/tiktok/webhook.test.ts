import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";
import { auditLog, staffUsers, tiktokShopConnections, tiktokWebhookEvents } from "@ammari/db/schema";
import { insertStaffUser } from "@ammari/db/test-fixtures";
import { testDb, withRollback, type TestDatabase } from "@ammari/db/test-utils";
import { Secret, type TikTokTokenSet, type TokenKeyring } from "@ammari/tiktok-shop";
import { saveTikTokConnection } from "./connection";
import {
  TIKTOK_WEBHOOK_MAX_ATTEMPTS,
  parseTikTokWebhookBody,
  processDueTikTokConnectionEvents,
  processTikTokWebhookEvent,
  recordTikTokWebhookEvent,
  tiktokWebhookRetryDelayMs,
  touchTikTokLastWebhook,
  type TikTokWebhookEvent,
} from "./webhook";

// docs/plans/tiktok-shop-integration.md T3: the inbox write (dedupe on tts_notification_id, shop
// check, allowlist), topics 6/7 applied to the connection, retries. Dummy tokens only.

const NOW = new Date("2026-11-27T03:00:00.000Z");
const DAY = 86_400_000;
const KEYRING: TokenKeyring = { currentVersion: 1, keys: new Map([[1, new Secret(new Uint8Array(32).fill(7))]]) };
const OFFICIAL_BODY = readFileSync(fileURLToPath(new URL("../../../tiktok-shop/test/fixtures/official-webhook-body.json", import.meta.url)), "utf8");
const SHOP_ID = "7495540735365777507"; // the official example's shop

function tokens(): TikTokTokenSet {
  return {
    accessToken: new Secret("ROW_access_t3"),
    accessTokenExpiresAt: new Date(NOW.getTime() + 7 * DAY),
    refreshToken: new Secret("ROW_refresh_t3"),
    refreshTokenExpiresAt: new Date(NOW.getTime() + 60 * DAY),
    grantedScopes: ["seller.order.info"],
    sellerName: "Ammari",
    sellerBaseRegion: "ID",
  };
}

let lastStaffId = "";
async function connect(db: TestDatabase, now = NOW, shopId = SHOP_ID): Promise<string> {
  const staff = await insertStaffUser(db);
  lastStaffId = staff.id;
  const result = await saveTikTokConnection(db, { tokens: tokens(), shop: { shopId, shopCipher: "ROW_cipher", shopName: "Ammari", region: "ID", sellerType: "LOCAL" }, staffUserId: staff.id, keyring: KEYRING, now });
  if (!result.ok) throw new Error(result.reason);
  return result.connectionId;
}

let sequence = 0;
function event(type: number, overrides: Record<string, unknown> = {}): TikTokWebhookEvent {
  sequence += 1;
  const body = { type, tts_notification_id: `t3-${Date.now()}-${sequence}`, shop_id: SHOP_ID, timestamp: Math.floor(NOW.getTime() / 1000) + 60, data: { order_id: "576653688135258178" }, ...overrides };
  const parsed = parseTikTokWebhookBody(JSON.stringify(body));
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.event;
}

async function eventRow(db: TestDatabase, id: string) {
  const [row] = await db.select().from(tiktokWebhookEvents).where(eq(tiktokWebhookEvents.id, id));
  return row!;
}

async function connection(db: TestDatabase, id: string) {
  const [row] = await db.select().from(tiktokShopConnections).where(eq(tiktokShopConnections.id, id));
  return row!;
}

describe("parseTikTokWebhookBody", () => {
  test("the official example parses; the payload keeps only allowlisted fields", () => {
    const parsed = parseTikTokWebhookBody(OFFICIAL_BODY);
    expect(parsed).toEqual({
      ok: true,
      event: {
        type: 1,
        ttsNotificationId: "7380066284010030890",
        shopId: SHOP_ID,
        tiktokOrderId: "576653688135258178",
        timestampS: 1718305585,
        payload: JSON.parse(OFFICIAL_BODY),
        payloadProblem: null,
      },
    });
  });

  test("buyer fields never survive, nested or new", () => {
    const body = {
      type: 3,
      tts_notification_id: "n-1",
      shop_id: SHOP_ID,
      timestamp: 1718305585,
      buyer_email: "pembeli@example.com",
      data: {
        order_id: "1",
        update_time: 1718305585,
        recipient_address: { name: "Siti Aminah", phone_number: "+6281234567890", full_address: "Jl. Merdeka 1" },
        buyer_message: "tolong cepat",
        user_id: "u-99",
        order_status: { nested: "Siti Aminah" },
      },
    };
    const parsed = parseTikTokWebhookBody(JSON.stringify(body));
    expect(parsed.ok).toBe(true);
    const stored = JSON.stringify(parsed.ok ? parsed.event.payload : null);
    for (const leaked of ["pembeli@example.com", "Siti Aminah", "+6281234567890", "Merdeka", "tolong cepat", "u-99", "buyer", "recipient", "user_id"]) expect(stored).not.toContain(leaked);
    expect(parsed.ok && parsed.event.payload).toEqual({ type: 3, tts_notification_id: "n-1", shop_id: SHOP_ID, timestamp: 1718305585, data: { order_id: "1", update_time: 1718305585 } });
  });

  test("refuses what cannot be deduped or routed", () => {
    for (const text of ["", "{", "not json", "[]", "null", "42"]) expect(parseTikTokWebhookBody(text).ok).toBe(false);
    expect(parseTikTokWebhookBody("{").ok ? null : (parseTikTokWebhookBody("{") as { reason: string }).reason).toBe("invalid_json");
    const base = { type: 1, tts_notification_id: "n", shop_id: "s" };
    for (const broken of [
      { ...base, type: "1" },
      { ...base, type: 1.5 },
      { ...base, type: 40_000 },
      { ...base, tts_notification_id: 7380066284010030890 },
      { ...base, tts_notification_id: "" },
      { ...base, tts_notification_id: "x".repeat(129) },
      { ...base, tts_notification_id: "has space" },
      { ...base, shop_id: undefined },
    ]) {
      expect(parseTikTokWebhookBody(JSON.stringify(broken))).toEqual({ ok: false, reason: "invalid_shape" });
    }
  });

  test("an oversized or NUL-carrying payload is dropped, the event kept with a code", () => {
    const big = parseTikTokWebhookBody(JSON.stringify({ type: 1, tts_notification_id: "n", shop_id: "s", data: { order_status: "x".repeat(9_000) } }));
    expect(big.ok && [big.event.payload, big.event.payloadProblem]).toEqual([null, "payload_too_large"]);
    for (const data of [{ order_status: "a\u0000b" }, { order_status: "lone \ud800 surrogate" }, { order_status: "\udc00" }, { order_id: [1e300, 1e300] }, { update_time: 1e300 }]) {
      const unstorable = parseTikTokWebhookBody(JSON.stringify({ type: 1, tts_notification_id: "n", shop_id: "s", data }));
      expect(unstorable.ok && [unstorable.event.payload, unstorable.event.payloadProblem]).toEqual([null, "payload_unstorable"]);
    }
    // A proper surrogate pair (emoji) and a backslash-u text are fine.
    const fine = parseTikTokWebhookBody(JSON.stringify({ type: 1, tts_notification_id: "n", shop_id: "s", data: { order_status: "ok \u{1F600} \\u0000" } }));
    expect(fine.ok && fine.event.payloadProblem).toBeNull();
  });
});

describe("recordTikTokWebhookEvent", () => {
  test("stores once per notification id; a redelivery writes nothing", async () => {
    await withRollback(async (tx) => {
      await connect(tx);
      const parsed = parseTikTokWebhookBody(OFFICIAL_BODY);
      if (!parsed.ok) throw new Error("fixture");
      const first = await recordTikTokWebhookEvent(tx, parsed.event);
      expect(first).toEqual({ kind: "stored", id: expect.any(String), status: "pending" });
      expect(await recordTikTokWebhookEvent(tx, parsed.event)).toEqual({ kind: "duplicate" });
      const rows = await tx.select().from(tiktokWebhookEvents).where(eq(tiktokWebhookEvents.ttsNotificationId, "7380066284010030890"));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ type: 1, shopId: SHOP_ID, tiktokOrderId: "576653688135258178", timestampS: 1718305585, status: "pending", attempts: 0, payload: JSON.parse(OFFICIAL_BODY) });
    });
  });

  test("a shop that is not ours is refused and nothing is stored", async () => {
    await withRollback(async (tx) => {
      const before = (await tx.select().from(tiktokWebhookEvents)).length;
      expect(await recordTikTokWebhookEvent(tx, event(1))).toEqual({ kind: "unknown_shop" });
      await connect(tx);
      expect(await recordTikTokWebhookEvent(tx, event(1, { shop_id: "7000000000000000999" }))).toEqual({ kind: "unknown_shop" });
      expect(await tx.select().from(tiktokWebhookEvents)).toHaveLength(before);
    });
  });

  test("topic 3 and unknown topics are stored ignored; 1, 6, 7, 11, 12 pending", async () => {
    await withRollback(async (tx) => {
      await connect(tx);
      const statuses: Record<number, string> = {};
      for (const type of [1, 3, 6, 7, 11, 12, 99]) {
        const result = await recordTikTokWebhookEvent(tx, event(type));
        if (result.kind !== "stored") throw new Error(result.kind);
        statuses[type] = result.status;
        const row = await eventRow(tx, result.id);
        expect(row.processedAt === null).toBe(result.status === "pending");
      }
      expect(statuses).toEqual({ 1: "pending", 3: "ignored", 6: "pending", 7: "pending", 11: "pending", 12: "pending", 99: "ignored" });
    });
  });

  test("payloads jsonb would refuse are stored as null; the insert never fails", async () => {
    await withRollback(async (tx) => {
      await connect(tx);
      for (const data of [{ order_status: "\ud800" }, { order_id: [1e300] }, { order_status: "a\u0000" }]) {
        const result = await recordTikTokWebhookEvent(tx, event(1, { data }));
        if (result.kind !== "stored") throw new Error(result.kind);
        expect(await eventRow(tx, result.id)).toMatchObject({ payload: null, lastErrorCode: "payload_unstorable" });
      }
    });
  });

  test("an oversized payload is stored as null with its code (the row still dedupes)", async () => {
    await withRollback(async (tx) => {
      await connect(tx);
      const big = event(1, { data: { order_id: "1", order_status: "x".repeat(9_000) } });
      const result = await recordTikTokWebhookEvent(tx, big);
      if (result.kind !== "stored") throw new Error(result.kind);
      expect(await eventRow(tx, result.id)).toMatchObject({ payload: null, lastErrorCode: "payload_too_large" });
    });
  });
});

describe("processTikTokWebhookEvent", () => {
  test("topic 6 deauthorizes the shop (tokens wiped, audited); a second run is a no-op", async () => {
    await withRollback(async (tx) => {
      const connectionId = await connect(tx);
      const stored = await recordTikTokWebhookEvent(tx, event(6));
      if (stored.kind !== "stored") throw new Error(stored.kind);
      expect(await processTikTokWebhookEvent(tx, stored.id, NOW)).toEqual({ kind: "processed", changed: true });
      const saved = await connection(tx, connectionId);
      expect(saved).toMatchObject({ status: "deauthorized", accessTokenCt: null, refreshTokenCt: null });
      expect(saved.deauthorizedAt).toEqual(new Date((Math.floor(NOW.getTime() / 1000) + 60) * 1000));
      expect(await eventRow(tx, stored.id)).toMatchObject({ status: "processed", processedAt: NOW });
      expect(await processTikTokWebhookEvent(tx, stored.id, NOW)).toEqual({ kind: "not_pending" });
      const audits = await tx.select().from(auditLog).where(and(eq(auditLog.entityId, connectionId), eq(auditLog.action, "tiktok_deauthorize")));
      expect(audits).toHaveLength(1);
    });
  });

  test("a deauthorization from before a reconnect never wipes the newer authorization, and says so", async () => {
    await withRollback(async (tx) => {
      const connectionId = await connect(tx, new Date(NOW.getTime() + DAY));
      const stored = await recordTikTokWebhookEvent(tx, event(6));
      if (stored.kind !== "stored") throw new Error(stored.kind);
      expect(await processTikTokWebhookEvent(tx, stored.id, NOW)).toEqual({ kind: "processed", changed: false, stale: true });
      expect((await connection(tx, connectionId)).status).toBe("active");
    });
  });

  test("an event stamped seconds before connected_at (second resolution, clock skew) still applies", async () => {
    await withRollback(async (tx) => {
      // Event timestamp = NOW + 60 s (see event()); connected 30 s after that.
      const connectionId = await connect(tx, new Date(NOW.getTime() + 90_000));
      const stored = await recordTikTokWebhookEvent(tx, event(6));
      if (stored.kind !== "stored") throw new Error(stored.kind);
      expect(await processTikTokWebhookEvent(tx, stored.id, NOW)).toEqual({ kind: "processed", changed: true });
      expect((await connection(tx, connectionId)).status).toBe("deauthorized");
    });
  });

  test("the sweep keeps going when one event throws", async () => {
    await withRollback(async (tx) => {
      await connect(tx);
      const first = await recordTikTokWebhookEvent(tx, event(7));
      const second = await recordTikTokWebhookEvent(tx, event(6));
      if (first.kind !== "stored" || second.kind !== "stored") throw new Error("not stored");
      let selects = 0;
      // The first event's own read throws (as if the database blipped); the second still applies.
      const flaky = new Proxy(tx, {
        get(target, key, receiver) {
          if (key === "select") {
            return (...args: unknown[]) => {
              selects += 1;
              if (selects === 2) throw Object.assign(new Error("blip"), { code: "08006" });
              return (Reflect.get(target, key, receiver) as (...a: unknown[]) => unknown).apply(target, args);
            };
          }
          return Reflect.get(target, key, receiver);
        },
      }) as TestDatabase;
      const results = await processDueTikTokConnectionEvents(flaky, { now: NOW });
      expect(results).toEqual([{ kind: "threw", errorCode: "pg:08006" }, { kind: "processed", changed: true }]);
    });
  });

  test("topic 7 records the expiry warning at the event's time", async () => {
    await withRollback(async (tx) => {
      const connectionId = await connect(tx);
      const stored = await recordTikTokWebhookEvent(tx, event(7));
      if (stored.kind !== "stored") throw new Error(stored.kind);
      expect(await processTikTokWebhookEvent(tx, stored.id, NOW)).toEqual({ kind: "processed", changed: true });
      const saved = await connection(tx, connectionId);
      expect(saved.status).toBe("active");
      expect(saved.expiryWarningAt).toEqual(new Date((Math.floor(NOW.getTime() / 1000) + 60) * 1000));
    });
  });

  test("an event time in the future is clamped to when it was received", async () => {
    await withRollback(async (tx) => {
      const connectionId = await connect(tx);
      const stored = await recordTikTokWebhookEvent(tx, event(7, { timestamp: 4_000_000_000 }));
      if (stored.kind !== "stored") throw new Error(stored.kind);
      await processTikTokWebhookEvent(tx, stored.id, NOW);
      const { receivedAt } = await eventRow(tx, stored.id);
      expect((await connection(tx, connectionId)).expiryWarningAt).toEqual(receivedAt);
    });
  });

  test("order, cancellation and return topics stay pending for the sync", async () => {
    await withRollback(async (tx) => {
      await connect(tx);
      for (const type of [1, 11, 12]) {
        const stored = await recordTikTokWebhookEvent(tx, event(type));
        if (stored.kind !== "stored") throw new Error(stored.kind);
        expect(await processTikTokWebhookEvent(tx, stored.id, NOW)).toEqual({ kind: "awaiting_sync" });
        expect(await eventRow(tx, stored.id)).toMatchObject({ status: "pending", attempts: 0, processedAt: null });
      }
    });
  });

  test("a failing connection write is retried with backoff and ends failed after the last attempt", async () => {
    await withRollback(async (tx) => {
      await connect(tx);
      const stored = await recordTikTokWebhookEvent(tx, event(6));
      if (stored.kind !== "stored") throw new Error(stored.kind);
      // A database whose connection write throws; reads and the inbox update go to the real one.
      const failing = new Proxy(tx, {
        get(target, key, receiver) {
          if (key === "transaction") return async () => {
            throw Object.assign(new Error("boom"), { code: "40001" });
          };
          return Reflect.get(target, key, receiver);
        },
      }) as TestDatabase;
      const first = await processTikTokWebhookEvent(failing, stored.id, NOW);
      expect(first).toEqual({ kind: "retry_scheduled", attempts: 1, errorCode: "pg:40001" });
      expect(await eventRow(tx, stored.id)).toMatchObject({ status: "pending", attempts: 1, lastErrorCode: "pg:40001", nextAttemptAt: new Date(NOW.getTime() + tiktokWebhookRetryDelayMs(1)) });
      // Not due yet: the sweep leaves it alone.
      expect(await processDueTikTokConnectionEvents(failing, { now: NOW })).toEqual([]);
      let last;
      for (let attempt = 2; attempt <= TIKTOK_WEBHOOK_MAX_ATTEMPTS; attempt += 1) last = await processTikTokWebhookEvent(failing, stored.id, NOW);
      expect(last).toEqual({ kind: "failed", attempts: TIKTOK_WEBHOOK_MAX_ATTEMPTS, errorCode: "pg:40001" });
      expect(await eventRow(tx, stored.id)).toMatchObject({ status: "failed", attempts: 10, nextAttemptAt: null });
    });
  });

  test("the sweep applies a pending topic 6 whose after() was lost", async () => {
    await withRollback(async (tx) => {
      const connectionId = await connect(tx);
      const stored = await recordTikTokWebhookEvent(tx, event(6));
      if (stored.kind !== "stored") throw new Error(stored.kind);
      const results = await processDueTikTokConnectionEvents(tx, { now: NOW });
      expect(results).toContainEqual({ kind: "processed", changed: true });
      expect((await connection(tx, connectionId)).status).toBe("deauthorized");
    });
  });
});

describe("touchTikTokLastWebhook", () => {
  test("moves last_webhook_at forward only", async () => {
    await withRollback(async (tx) => {
      const connectionId = await connect(tx);
      await touchTikTokLastWebhook(tx, SHOP_ID, NOW);
      await touchTikTokLastWebhook(tx, SHOP_ID, new Date(NOW.getTime() - 1000));
      expect((await connection(tx, connectionId)).lastWebhookAt).toEqual(NOW);
    });
  });

  test("skips a row held by a token refresh instead of waiting", async () => {
    // Committed for real (two connections): its own shop id, so a leftover row after a killed run
    // can never make the official example's shop "ours" in another test.
    const shopId = `t3-skip-${Date.now()}`;
    const connectionId = await connect(testDb, NOW, shopId);
    const staffId = lastStaffId;
    try {
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const isLocked = new Promise<void>((resolve) => (locked = resolve));
      const holder = testDb.transaction(async (tx) => {
        await tx.select().from(tiktokShopConnections).where(eq(tiktokShopConnections.id, connectionId)).for("update");
        locked();
        await held;
      });
      await isLocked;
      const started = Date.now();
      try {
        await touchTikTokLastWebhook(testDb, shopId, NOW);
      } finally {
        release();
        await holder;
      }
      expect(Date.now() - started).toBeLessThan(1_000);
      expect((await connection(testDb, connectionId)).lastWebhookAt).toBeNull();
    } finally {
      await testDb.delete(auditLog).where(eq(auditLog.entityId, connectionId));
      await testDb.delete(tiktokShopConnections).where(eq(tiktokShopConnections.id, connectionId));
      await testDb.delete(staffUsers).where(eq(staffUsers.id, staffId));
    }
  });
});
