import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ClaimOutcome } from "@/lib/claim/queries";

// The claim action's own branching only (who lands where after "Klaim Sekarang"): the claim
// transaction itself is covered against the real database by lib/claim/queries.test.ts. Next's
// redirect() throws to abort the action; the mock below throws the same way so a test can read
// the target.

class RedirectSignal extends Error {
  constructor(readonly to: string) {
    super(`redirect ${to}`);
  }
}

let outcome: ClaimOutcome;
let attempts = 0;

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
}));
vi.mock("@/lib/auth/require-customer", () => ({
  requireConsentedSession: async () => ({ id: "customer-1", pdpConsentAt: new Date() }),
}));
vi.mock("@/lib/claim/ip", () => ({ getClaimClientIp: async () => "203.0.113.9" }));
vi.mock("@/lib/claim/throttle", () => ({
  CLAIM_SUBMIT_WINDOW_SECONDS: 600,
  CLAIM_SUBMIT_LIMIT: 10,
  recordClaimAttemptAndCount: async () => attempts,
}));
vi.mock("@/lib/claim/queries", () => ({ claimVoucher: async () => outcome }));
vi.mock("@/lib/db", () => ({ defaultDb: {} }));

const { claimAction } = await import("./actions");
const { VOUCHER_CLAIMED_REDIRECT } = await import("@/lib/claim/claimed-notice");

function form(token = "ABCD1234"): FormData {
  const data = new FormData();
  data.set("token", token);
  return data;
}

async function redirectOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    if (error instanceof RedirectSignal) return error.to;
    throw error;
  }
  throw new Error("expected a redirect");
}

beforeEach(() => {
  attempts = 0;
});

describe("claimAction", () => {
  test("a successful claim sends the buyer to the homepage collection with the claimed notice", async () => {
    outcome = { ok: true, voucher: { amount: 20_000, expiresAt: new Date("2027-03-01T00:00:00Z") } };
    const to = await redirectOf(claimAction({ status: "idle" }, form()));
    expect(to).toBe(VOUCHER_CLAIMED_REDIRECT);
    expect(to).toBe("/?voucher=claimed#koleksi");
  });

  test("a rejected claim stays on the page with its message, no redirect", async () => {
    outcome = { ok: false, reason: "expired", claimedByCustomerId: null };
    await expect(claimAction({ status: "idle" }, form())).resolves.toEqual({ status: "error", message: "Batas waktu klaim voucher ini sudah lewat." });
  });

  test("rate limited: a message, never a claim or a redirect", async () => {
    attempts = 10;
    outcome = { ok: true, voucher: { amount: 20_000, expiresAt: new Date() } };
    const state = await claimAction({ status: "idle" }, form());
    expect(state.status).toBe("error");
  });

  test("consent missing inside the transaction: back to /consent, carrying the claim page as next", async () => {
    outcome = { ok: false, reason: "consent_required", claimedByCustomerId: null };
    expect(await redirectOf(claimAction({ status: "idle" }, form("ABCD1234")))).toBe(`/consent?next=${encodeURIComponent("/claim/ABCD1234")}`);
  });
});
