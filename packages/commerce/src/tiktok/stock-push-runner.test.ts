import { describe, expect, test } from "vitest";
import { createTikTokStockPushScheduler } from "./stock-push-runner";

// The after() push's single flight (S2): one push at a time per process, one more after it when asked
// meanwhile, never a failure for the caller.

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("createTikTokStockPushScheduler", () => {
  test("requests during a run coalesce into exactly one more run", async () => {
    const gates = [deferred(), deferred()];
    let runs = 0;
    let concurrent = 0;
    let maxConcurrent = 0;
    const request = createTikTokStockPushScheduler(async () => {
      const gate = gates[runs++];
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await gate?.promise;
      concurrent -= 1;
    });
    const first = request();
    request();
    request();
    request();
    gates[0]!.resolve();
    gates[1]!.resolve();
    await first;
    expect(runs).toBe(2);
    expect(maxConcurrent).toBe(1);
  });

  test("a run that throws never rejects the caller, and the next request runs again", async () => {
    let runs = 0;
    const request = createTikTokStockPushScheduler(async () => {
      runs += 1;
      throw new Error("boom");
    });
    await expect(request()).resolves.toBeUndefined();
    await expect(request()).resolves.toBeUndefined();
    expect(runs).toBe(2);
  });
});
