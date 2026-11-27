import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { withRollback, type TestTx } from "@ammari/db/test-utils";
import { insertStaffUser } from "@ammari/db/test-fixtures";
import { tiktokShopConnections, tiktokWebhookEvents } from "@ammari/db/schema";
import { saveTikTokConnection } from "@ammari/commerce/tiktok";
import { Secret, computeWebhookSignature, type TokenKeyring } from "@ammari/tiktok-shop";

// docs/plans/tiktok-shop-integration.md T3: the webhook route, against the official TikTok example
// (packages/tiktok-shop/test/fixtures, dummy credentials from TikTok's docs) and our own signed
// bodies. Each test runs inside a rolled-back transaction; nothing reaches TikTok.

let currentDb: unknown = null;
vi.mock("@/lib/db", () => ({
  get defaultDb() {
    if (!currentDb) throw new Error("no test transaction");
    return currentDb;
  },
}));
// `after()` callbacks are collected and run by the test, as Next runs them after the answer.
const pending: (() => Promise<void>)[] = [];
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (callback: () => Promise<void>) => {
    pending.push(callback);
  },
}));

const { POST } = await import("./route");

const fixtures = fileURLToPath(new URL("../../../../../../../../packages/tiktok-shop/test/fixtures/", import.meta.url));
const vectors = JSON.parse(readFileSync(`${fixtures}official-vectors.json`, "utf8")) as {
  official: { webhook: { app_key: string; app_secret: string; authorization: string; body_file: string; body_length: number } };
};
const OFFICIAL = vectors.official.webhook;
const OFFICIAL_BODY: Buffer = readFileSync(`${fixtures}${OFFICIAL.body_file}`);
const SHOP_ID = "7495540735365777507"; // the official example's shop
const URL_ = "http://localhost:3100/api/integrations/tiktok/webhook";

const ENC_KEY = randomBytes(32);
const KEYRING: TokenKeyring = { currentVersion: 1, keys: new Map([[1, new Secret(new Uint8Array(ENC_KEY))]]) };
let appKey = OFFICIAL.app_key;
let appSecret = OFFICIAL.app_secret;
const ENV_NAMES = ["TIKTOK_APP_KEY", "TIKTOK_APP_SECRET", "TIKTOK_TOKEN_ENC_KEY_V1", "TIKTOK_TOKEN_ENC_KEY_CURRENT", "TIKTOK_PROVIDER", "TIKTOK_SERVICE_ID"];

function setEnv(): void {
  Object.assign(process.env, { TIKTOK_APP_KEY: appKey, TIKTOK_APP_SECRET: appSecret, TIKTOK_TOKEN_ENC_KEY_V1: ENC_KEY.toString("base64"), TIKTOK_TOKEN_ENC_KEY_CURRENT: "1" });
}

beforeEach(() => {
  appKey = OFFICIAL.app_key;
  appSecret = OFFICIAL.app_secret;
  for (const name of ENV_NAMES) delete process.env[name];
  setEnv();
  pending.length = 0;
});
afterEach(() => {
  for (const name of ENV_NAMES) delete process.env[name];
  currentDb = null;
  vi.restoreAllMocks();
});

async function inRollback(fn: (tx: TestTx) => Promise<void>): Promise<void> {
  await withRollback(async (tx) => {
    currentDb = tx;
    await fn(tx);
  });
}

async function runAfter(): Promise<void> {
  while (pending.length > 0) await pending.shift()!();
}

async function connectShop(tx: TestTx): Promise<string> {
  const staff = await insertStaffUser(tx);
  const now = new Date(Date.now() - 60 * 60 * 1000);
  const result = await saveTikTokConnection(tx, {
    tokens: { accessToken: new Secret("ROW_access_web"), accessTokenExpiresAt: new Date(now.getTime() + 7 * 86_400_000), refreshToken: new Secret("ROW_refresh_web"), refreshTokenExpiresAt: new Date(now.getTime() + 60 * 86_400_000), grantedScopes: [], sellerName: null, sellerBaseRegion: null },
    shop: { shopId: SHOP_ID, shopCipher: "ROW_cipher_web", shopName: "Ammari", region: "ID", sellerType: "LOCAL" },
    staffUserId: staff.id,
    keyring: KEYRING,
    now,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.connectionId;
}

function sign(body: Buffer | string): string {
  return computeWebhookSignature(appKey, appSecret, body).toString("hex");
}

function post(body: Buffer | string | ReadableStream<Uint8Array>, headers: Record<string, string | undefined> = {}): Promise<Response> {
  const merged: Record<string, string> = {};
  for (const [name, value] of Object.entries({ "content-type": "application/json", ...headers })) if (value !== undefined) merged[name] = value;
  return POST(new Request(URL_, { method: "POST", headers: merged, body: body as BodyInit, ...(body instanceof ReadableStream ? { duplex: "half" } : {}) } as RequestInit));
}

let sequence = 0;
function ownBody(type: number, extra: Record<string, unknown> = {}): string {
  sequence += 1;
  return JSON.stringify({ type, tts_notification_id: `web-${Date.now()}-${sequence}`, shop_id: SHOP_ID, timestamp: Math.floor(Date.now() / 1000), data: { order_id: "576653688135258178" }, ...extra });
}

async function rows(tx: TestTx) {
  return tx.select().from(tiktokWebhookEvents).where(eq(tiktokWebhookEvents.shopId, SHOP_ID));
}

function quietLogs() {
  return {
    info: vi.spyOn(console, "info").mockImplementation(() => undefined),
    warn: vi.spyOn(console, "warn").mockImplementation(() => undefined),
    error: vi.spyOn(console, "error").mockImplementation(() => undefined),
  };
}

async function expectEmpty(response: Response, status: number): Promise<void> {
  expect(response.status).toBe(status);
  expect(await response.text()).toBe("");
}

describe("POST /api/integrations/tiktok/webhook", () => {
  test("the official TikTok example verifies, is stored, and gets 200 with an empty body", async () => {
    await inRollback(async (tx) => {
      quietLogs();
      const connectionId = await connectShop(tx);
      expect(OFFICIAL_BODY.length).toBe(OFFICIAL.body_length);
      await expectEmpty(await post(OFFICIAL_BODY, { authorization: OFFICIAL.authorization }), 200);
      const stored = await rows(tx);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ ttsNotificationId: "7380066284010030890", type: 1, tiktokOrderId: "576653688135258178", status: "pending", payload: JSON.parse(OFFICIAL_BODY.toString("utf8")) });
      await runAfter();
      // Topic 1 waits for the sync (T4); "last webhook" is set.
      expect((await rows(tx))[0]!.status).toBe("pending");
      const [connection] = await tx.select().from(tiktokShopConnections).where(eq(tiktokShopConnections.id, connectionId));
      expect(connection!.lastWebhookAt).not.toBeNull();
      expect(connection!.status).toBe("active");
    });
  });

  test("a redelivery of the same tts_notification_id answers 200 and stores nothing more", async () => {
    await inRollback(async (tx) => {
      quietLogs();
      await connectShop(tx);
      for (let i = 0; i < 3; i += 1) await expectEmpty(await post(OFFICIAL_BODY, { authorization: OFFICIAL.authorization }), 200);
      expect(await rows(tx)).toHaveLength(1);
      await runAfter();
      expect(await rows(tx)).toHaveLength(1);
    });
  });

  test("a missing, wrong, uppercase or prefixed signature is 401 and stores nothing", async () => {
    await inRollback(async (tx) => {
      quietLogs();
      await connectShop(tx);
      for (const authorization of [undefined, "", "0".repeat(64), OFFICIAL.authorization.toUpperCase(), `Bearer ${OFFICIAL.authorization}`, OFFICIAL.authorization.slice(0, 63)]) {
        await expectEmpty(await post(OFFICIAL_BODY, { authorization }), 401);
      }
      // Signed with another app's secret.
      appSecret = "another-secret";
      await expectEmpty(await post(OFFICIAL_BODY, { authorization: sign(OFFICIAL_BODY) }), 401);
      expect(await rows(tx)).toHaveLength(0);
      expect(pending).toHaveLength(0);
    });
  });

  test("a tampered body (one byte, or re-serialized) fails the official signature", async () => {
    await inRollback(async (tx) => {
      quietLogs();
      await connectShop(tx);
      const flipped = Buffer.from(OFFICIAL_BODY);
      flipped[flipped.indexOf("UNPAID")] = "u".charCodeAt(0);
      const reserialized = JSON.stringify(JSON.parse(OFFICIAL_BODY.toString("utf8")), null, 1);
      const trailing = Buffer.concat([OFFICIAL_BODY, Buffer.from("\n")]);
      for (const body of [flipped, reserialized, trailing]) await expectEmpty(await post(body, { authorization: OFFICIAL.authorization }), 401);
      expect(await rows(tx)).toHaveLength(0);
    });
  });

  test("a body over 64 KB is 413 and stores nothing, declared or streamed", async () => {
    await inRollback(async (tx) => {
      quietLogs();
      await connectShop(tx);
      const huge = ownBody(1, { padding: "x".repeat(70_000) });
      await expectEmpty(await post(huge, { authorization: sign(huge) }), 413);
      // No Content-Length: the stream is cut at the cap.
      const bytes = Buffer.from(huge);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let offset = 0; offset < bytes.length; offset += 8_192) controller.enqueue(bytes.subarray(offset, offset + 8_192));
          controller.close();
        },
      });
      await expectEmpty(await post(stream, { authorization: sign(huge) }), 413);
      // Declared too large: refused before reading a byte.
      await expectEmpty(await post(huge, { authorization: sign(huge), "content-length": "70000" }), 413);
      expect(await rows(tx)).toHaveLength(0);
    });
  });

  test("a body that does not arrive within 2 s is 400 and stores nothing (no slow-drip hold)", async () => {
    await inRollback(async (tx) => {
      quietLogs();
      await connectShop(tx);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{\"type\":1"));
          // ...and never closes.
        },
      });
      const started = Date.now();
      await expectEmpty(await post(stream, { authorization: OFFICIAL.authorization }), 400);
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(await rows(tx)).toHaveLength(0);
    });
  });

  test("anything but application/json is 415 and stores nothing", async () => {
    await inRollback(async (tx) => {
      quietLogs();
      await connectShop(tx);
      for (const contentType of [undefined, "text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
        const response = await POST(new Request(URL_, { method: "POST", headers: { authorization: OFFICIAL.authorization, ...(contentType ? { "content-type": contentType } : {}) }, body: new Uint8Array(OFFICIAL_BODY) }));
        // A Request with a Buffer body and no header gets no content type.
        await expectEmpty(response, 415);
      }
      // A charset parameter is fine.
      await expectEmpty(await post(OFFICIAL_BODY, { authorization: OFFICIAL.authorization, "content-type": "application/json; charset=utf-8" }), 200);
      expect(await rows(tx)).toHaveLength(1);
    });
  });

  test("integration off (any variable missing or invalid) is 503, before anything is read or stored", async () => {
    await inRollback(async (tx) => {
      const logs = quietLogs();
      await connectShop(tx);
      for (const change of [{ TIKTOK_APP_SECRET: undefined }, { TIKTOK_APP_KEY: undefined }, { TIKTOK_TOKEN_ENC_KEY_V1: undefined }, { TIKTOK_TOKEN_ENC_KEY_V1: "short" }, { TIKTOK_PROVIDER: "fake" }]) {
        setEnv();
        for (const [name, value] of Object.entries(change)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
        await expectEmpty(await post(OFFICIAL_BODY, { authorization: OFFICIAL.authorization }), 503);
        delete process.env.TIKTOK_PROVIDER;
      }
      expect(await rows(tx)).toHaveLength(0);
      // Problems name variables, never values.
      expect(JSON.stringify(logs.error.mock.calls)).not.toContain(ENC_KEY.toString("base64"));
    });
  });

  test("a shop that is not ours is 401 and stores nothing", async () => {
    await inRollback(async (tx) => {
      quietLogs();
      // No connection at all yet.
      await expectEmpty(await post(OFFICIAL_BODY, { authorization: OFFICIAL.authorization }), 401);
      await connectShop(tx);
      const other = ownBody(1, { shop_id: "7000000000000000999" });
      await expectEmpty(await post(other, { authorization: sign(other) }), 401);
      expect(await tx.select().from(tiktokWebhookEvents).where(eq(tiktokWebhookEvents.shopId, "7000000000000000999"))).toHaveLength(0);
      expect(await rows(tx)).toHaveLength(0);
    });
  });

  test("a signed but malformed body is 200 (a retry cannot fix it), logged, not stored", async () => {
    await inRollback(async (tx) => {
      const logs = quietLogs();
      await connectShop(tx);
      for (const body of ["{not json", JSON.stringify({ type: 1, shop_id: SHOP_ID }), JSON.stringify([1, 2])]) await expectEmpty(await post(body, { authorization: sign(body) }), 200);
      expect(await rows(tx)).toHaveLength(0);
      // Logged as errors: TikTok's own signed body, lost for good.
      expect(logs.error.mock.calls.map(([, fields]) => (fields as { result: string }).result)).toEqual(["invalid_json", "invalid_shape", "invalid_shape"]);
    });
  });

  test("the database down is 503", async () => {
    const logs = quietLogs();
    currentDb = { execute: () => Promise.reject(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })) };
    await expectEmpty(await post(OFFICIAL_BODY, { authorization: OFFICIAL.authorization }), 503);
    expect(pending).toHaveLength(0);
    expect(logs.error).toHaveBeenCalledWith("[tiktok] webhook", expect.objectContaining({ result: "db_failed", code: "ECONNREFUSED" }));
  });

  test("a database that hangs still gets an answer within 3 seconds (503, TikTok retries)", async () => {
    const logs = quietLogs();
    let queried = false;
    currentDb = {
      execute: () => {
        queried = true;
        return new Promise(() => undefined);
      },
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let settled = false;
      const answer = post(OFFICIAL_BODY, { authorization: OFFICIAL.authorization }).then((response) => {
        settled = true;
        return response;
      });
      await vi.advanceTimersByTimeAsync(2_400);
      expect(settled).toBe(false);
      // The budget is 2.5 s from the request's start: under TikTok's 3 s.
      await vi.advanceTimersByTimeAsync(100);
      await expectEmpty(await answer, 503);
    } finally {
      vi.useRealTimers();
    }
    expect(queried).toBe(true);
    expect(logs.error).toHaveBeenCalledWith("[tiktok] webhook", expect.objectContaining({ result: "db_timeout" }));
  });

  test("a stored delivery answers fast with the real database, no TikTok call in the request", async () => {
    await inRollback(async (tx) => {
      quietLogs();
      await connectShop(tx);
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const started = Date.now();
      await expectEmpty(await post(OFFICIAL_BODY, { authorization: OFFICIAL.authorization }), 200);
      expect(Date.now() - started).toBeLessThan(3_000);
      await runAfter();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  test("topic 6 deauthorizes the shop after the answer; topic 7 records the expiry warning", async () => {
    await inRollback(async (tx) => {
      quietLogs();
      const connectionId = await connectShop(tx);
      const warning = ownBody(7);
      await expectEmpty(await post(warning, { authorization: sign(warning) }), 200);
      // Nothing changes in the request itself.
      let [connection] = await tx.select().from(tiktokShopConnections).where(eq(tiktokShopConnections.id, connectionId));
      expect(connection!.expiryWarningAt).toBeNull();
      await runAfter();
      [connection] = await tx.select().from(tiktokShopConnections).where(eq(tiktokShopConnections.id, connectionId));
      expect(connection!.expiryWarningAt).not.toBeNull();
      expect(connection!.status).toBe("active");

      const deauth = ownBody(6);
      await expectEmpty(await post(deauth, { authorization: sign(deauth) }), 200);
      expect((await tx.select().from(tiktokShopConnections).where(eq(tiktokShopConnections.id, connectionId)))[0]!.status).toBe("active");
      await runAfter();
      [connection] = await tx.select().from(tiktokShopConnections).where(eq(tiktokShopConnections.id, connectionId));
      expect(connection).toMatchObject({ status: "deauthorized", accessTokenCt: null, refreshTokenCt: null });
      expect((await rows(tx)).map((row) => [row.type, row.status]).sort()).toEqual([
        [6, "processed"],
        [7, "processed"],
      ]);
    });
  });

  test("a deauthorization whose processing was lost is applied when TikTok redelivers it", async () => {
    await inRollback(async (tx) => {
      quietLogs();
      const connectionId = await connectShop(tx);
      const deauth = ownBody(6);
      await expectEmpty(await post(deauth, { authorization: sign(deauth) }), 200);
      pending.length = 0; // the process restarted before after() ran
      expect((await tx.select().from(tiktokShopConnections).where(eq(tiktokShopConnections.id, connectionId)))[0]!.status).toBe("active");
      // TikTok redelivers (e.g. our first answer was a 503 after a late commit): a duplicate.
      await expectEmpty(await post(deauth, { authorization: sign(deauth) }), 200);
      await runAfter();
      expect((await tx.select().from(tiktokShopConnections).where(eq(tiktokShopConnections.id, connectionId)))[0]!.status).toBe("deauthorized");
      expect((await rows(tx)).map((row) => row.status)).toEqual(["processed"]);
    });
  });

  test("a failing last-webhook update does not stop topic 6 from being applied", async () => {
    await inRollback(async (tx) => {
      const logs = quietLogs();
      const connectionId = await connectShop(tx);
      // The first raw statement after the insert (the last-webhook update) fails once.
      let executes = 0;
      currentDb = new Proxy(tx, {
        get(target, key, receiver) {
          if (key === "execute") {
            return (...args: unknown[]) => {
              executes += 1;
              if (executes === 2) return Promise.reject(Object.assign(new Error("blip"), { code: "08006" }));
              return (Reflect.get(target, key, receiver) as (...a: unknown[]) => unknown).apply(target, args);
            };
          }
          return Reflect.get(target, key, receiver);
        },
      });
      const deauth = ownBody(6);
      await expectEmpty(await post(deauth, { authorization: sign(deauth) }), 200);
      await runAfter();
      expect((await tx.select().from(tiktokShopConnections).where(eq(tiktokShopConnections.id, connectionId)))[0]!.status).toBe("deauthorized");
      expect(logs.error).toHaveBeenCalledWith("[tiktok] webhook could not set the last-webhook time", expect.objectContaining({ code: "08006" }));
    });
  });

  test("topics 1, 11, 12 are stored pending for the sync; 3 and unknown topics ignored", async () => {
    await inRollback(async (tx) => {
      quietLogs();
      await connectShop(tx);
      for (const type of [1, 3, 11, 12, 99]) {
        const body = ownBody(type);
        await expectEmpty(await post(body, { authorization: sign(body) }), 200);
      }
      await runAfter();
      expect(Object.fromEntries((await rows(tx)).map((row) => [row.type, row.status]))).toEqual({ 1: "pending", 3: "ignored", 11: "pending", 12: "pending", 99: "ignored" });
    });
  });

  test("no secret, signature, token or body content in any log line", async () => {
    await inRollback(async (tx) => {
      const logs = quietLogs();
      appKey = `key${randomBytes(8).toString("hex")}`;
      appSecret = `sec${randomBytes(16).toString("hex")}`;
      setEnv();
      await connectShop(tx);
      const body = ownBody(3, { data: { order_id: "576653688135258178", recipient_address: { name: "Siti Aminah", phone_number: "+6281234567890" }, buyer_message: "tolong cepat" } });
      const signature = sign(body);
      await post(body, { authorization: signature });
      await post(body, { authorization: signature }); // duplicate
      await post(body, { authorization: "f".repeat(64) }); // bad signature
      await post(body, { authorization: signature, "content-type": "text/plain" });
      await post("{oops", { authorization: sign("{oops") });
      delete process.env.TIKTOK_APP_SECRET;
      await post(body, { authorization: signature }); // not configured
      setEnv();
      const deauth = ownBody(6);
      await post(deauth, { authorization: sign(deauth) });
      await runAfter();
      const everything = JSON.stringify([...logs.info.mock.calls, ...logs.warn.mock.calls, ...logs.error.mock.calls]);
      expect(everything).toContain("[tiktok] webhook");
      for (const leaked of [appKey, appSecret, signature, "f".repeat(64), "Siti Aminah", "+6281234567890", "tolong cepat", "576653688135258178", "ROW_access", "ROW_refresh", "ROW_cipher", "{oops"]) {
        expect(everything).not.toContain(leaked);
      }
      // Nor in the stored payload.
      const stored = JSON.stringify(await rows(tx));
      for (const leaked of ["Siti Aminah", "+6281234567890", "tolong cepat"]) expect(stored).not.toContain(leaked);
    });
  });
});
