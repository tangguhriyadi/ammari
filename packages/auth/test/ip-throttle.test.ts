import { afterEach, describe, expect, test } from "vitest";
import { eq, sql } from "drizzle-orm";
import { authIpThrottle } from "@ammari/db/schema";
import { recordIpThrottleAttempt } from "../src/shared/ip-throttle";
import { testDb } from "./customer-setup";

async function cleanupIpThrottle(ip: string): Promise<void> {
  await testDb.delete(authIpThrottle).where(eq(authIpThrottle.ip, ip));
}

/** Same technique as the email-throttle tests' own `backdateThrottleRows` — real elapsed time
 * between attempts without a real wait, since the window is computed against Postgres's own
 * `now()`. */
async function backdateIpThrottleRows(ip: string, seconds: number): Promise<void> {
  await testDb
    .update(authIpThrottle)
    .set({ createdAt: sql`now() - make_interval(secs => ${seconds})` })
    .where(eq(authIpThrottle.ip, ip));
}

describe("recordIpThrottleAttempt", () => {
  test("allows every request up to and including max", async () => {
    const ip = `203.0.113.${Date.now() % 255}-a`;
    for (let i = 1; i <= 30; i++) {
      const decision = await recordIpThrottleAttempt(testDb, ip, { windowSeconds: 600, max: 30 });
      expect(decision.limited).toBe(false);
    }
    await cleanupIpThrottle(ip);
  });

  test("blocks the request once more than max attempts land inside the window", async () => {
    const ip = `203.0.113.${Date.now() % 255}-b`;
    for (let i = 1; i <= 30; i++) {
      await recordIpThrottleAttempt(testDb, ip, { windowSeconds: 600, max: 30 });
    }
    const decision = await recordIpThrottleAttempt(testDb, ip, { windowSeconds: 600, max: 30 });
    expect(decision.limited).toBe(true);
    await cleanupIpThrottle(ip);
  });

  test("a different IP has its own independent counter", async () => {
    const ipA = `203.0.113.${Date.now() % 255}-c1`;
    const ipB = `203.0.113.${Date.now() % 255}-c2`;
    for (let i = 1; i <= 30; i++) {
      await recordIpThrottleAttempt(testDb, ipA, { windowSeconds: 600, max: 30 });
    }
    const decisionA = await recordIpThrottleAttempt(testDb, ipA, { windowSeconds: 600, max: 30 });
    const decisionB = await recordIpThrottleAttempt(testDb, ipB, { windowSeconds: 600, max: 30 });
    expect(decisionA.limited).toBe(true);
    expect(decisionB.limited).toBe(false);
    await cleanupIpThrottle(ipA);
    await cleanupIpThrottle(ipB);
  });

  test("once attempts age out of the window, the counter effectively resets", async () => {
    const ip = `203.0.113.${Date.now() % 255}-d`;
    for (let i = 1; i <= 30; i++) {
      await recordIpThrottleAttempt(testDb, ip, { windowSeconds: 600, max: 30 });
    }
    await backdateIpThrottleRows(ip, 601); // push every row outside the 600s window
    const decision = await recordIpThrottleAttempt(testDb, ip, { windowSeconds: 600, max: 30 });
    expect(decision.limited).toBe(false);
    await cleanupIpThrottle(ip);
  });
});
