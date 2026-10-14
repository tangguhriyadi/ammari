import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

const { getCustomerSessionMock, lookupClaimCardMock, recordClaimAttemptAndCountMock, getClaimClientIpMock } = vi.hoisted(() => ({
  getCustomerSessionMock: vi.fn(),
  lookupClaimCardMock: vi.fn(),
  recordClaimAttemptAndCountMock: vi.fn(),
  getClaimClientIpMock: vi.fn(),
}));

vi.mock("@/lib/auth/customer-session", () => ({ getCustomerSession: getCustomerSessionMock }));
vi.mock("@/lib/claim/queries", () => ({ lookupClaimCard: lookupClaimCardMock }));
vi.mock("@/lib/claim/ip", () => ({ getClaimClientIp: getClaimClientIpMock }));
vi.mock("@/lib/claim/throttle", () => ({
  recordClaimAttemptAndCount: recordClaimAttemptAndCountMock,
  CLAIM_VIEW_WINDOW_SECONDS: 600,
  CLAIM_VIEW_LIMIT: 30,
  CLAIM_SUBMIT_WINDOW_SECONDS: 600,
  CLAIM_SUBMIT_LIMIT: 10,
}));
vi.mock("@/lib/db", () => ({ defaultDb: {} }));

const { default: ClaimTokenPage } = await import("./page");

function renderPage(token = "SOME-TOKEN") {
  return ClaimTokenPage({ params: Promise.resolve({ token }) });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ClaimTokenPage — pre-login", () => {
  test("a signed-out visitor sees only the generic invite, and no order lookup ever runs", async () => {
    getClaimClientIpMock.mockResolvedValue("127.0.0.1");
    recordClaimAttemptAndCountMock.mockResolvedValue(1);
    getCustomerSessionMock.mockResolvedValue(null);

    const element = await renderPage();
    const html = renderToStaticMarkup(element);

    expect(html).toContain("Voucher Rp20.000 menunggumu");
    expect(html).toContain("Masuk untuk mengklaim voucher");
    expect(html).toContain("/login?next=");
    // The claim/card lookup must never run for a signed-out visitor — there is nothing in this
    // branch's output that could leak an order's existence, state, or rejection reason.
    expect(lookupClaimCardMock).not.toHaveBeenCalled();
  });

  test("rate-limited views show a generic retry message without ever touching the card lookup", async () => {
    getClaimClientIpMock.mockResolvedValue("127.0.0.1");
    recordClaimAttemptAndCountMock.mockResolvedValue(30);

    const element = await renderPage();
    const html = renderToStaticMarkup(element);

    expect(html).toContain("Terlalu banyak percobaan");
    expect(lookupClaimCardMock).not.toHaveBeenCalled();
    expect(getCustomerSessionMock).not.toHaveBeenCalled();
  });
});

describe("ClaimTokenPage — signed in, consented", () => {
  test("a card the signed-in customer claimed themselves shows the 'already yours' message and an /account link", async () => {
    getClaimClientIpMock.mockResolvedValue("127.0.0.1");
    recordClaimAttemptAndCountMock.mockResolvedValue(1);
    const me = { id: "customer-me", name: "Me", email: "me@example.test", phone: null, pdpConsentAt: new Date() };
    getCustomerSessionMock.mockResolvedValue(me);
    lookupClaimCardMock.mockResolvedValue({ status: "rejected", reason: "claimed", claimedByCustomerId: "customer-me" });

    const element = await renderPage();
    const html = renderToStaticMarkup(element);

    expect(html).toContain("Voucher ini sudah kamu klaim");
    expect(html).toContain("/account");
  });

  test("a card claimed by someone else shows only the generic rejection, never naming anyone", async () => {
    getClaimClientIpMock.mockResolvedValue("127.0.0.1");
    recordClaimAttemptAndCountMock.mockResolvedValue(1);
    const me = { id: "customer-me", name: "Me", email: "me@example.test", phone: null, pdpConsentAt: new Date() };
    getCustomerSessionMock.mockResolvedValue(me);
    lookupClaimCardMock.mockResolvedValue({ status: "rejected", reason: "claimed", claimedByCustomerId: "someone-else" });

    const element = await renderPage();
    const html = renderToStaticMarkup(element);

    expect(html).toContain("Voucher tidak bisa diklaim");
    expect(html).toContain("Voucher ini sudah diklaim.");
    expect(html).not.toContain("/account");
    expect(html).not.toContain("someone-else");
  });
});
