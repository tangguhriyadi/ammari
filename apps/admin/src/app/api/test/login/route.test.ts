import { describe, expect, test } from "vitest";
import { POST } from "./route";

// Deliberately NO env manipulation in this file — the whole admin test suite (vitest.config.mts)
// never sets E2E_TEST_LOGIN anywhere, which is exactly the condition that must hold in any real
// deployment (grep deploy/ confirms it's never set there either). This proves the backdoor is
// unreachable BY CONSTRUCTION in that state — not just that isE2eLoginRequestAllowed() says so
// in isolation (e2e-login-gate.test.ts), but that the real route handler, wired to the real
// (null) capturingEmailSender/e2eSignInAuth this env produces, actually returns 404.
describe("POST /api/test/login — e2e flag absent (the deployed/production condition)", () => {
  test("responds 404 for a request that would otherwise look completely legitimate", async () => {
    const request = new Request("http://localhost:3001/api/test/login", {
      method: "POST",
      headers: { host: "localhost:3001", "content-type": "application/json" },
      body: JSON.stringify({ email: "super-admin@e2e.ammari.test" }),
    });
    const response = await POST(request as never);
    expect(response.status).toBe(404);
  });

  test("responds 404 for a request with no body at all", async () => {
    const request = new Request("http://localhost:3001/api/test/login", { method: "POST" });
    const response = await POST(request as never);
    expect(response.status).toBe(404);
  });
});
