import { describe, expect, test } from "vitest";
import { POST } from "./route";

// Same reasoning as apps/admin's api/test/login/route.test.ts — no env manipulation here at
// all. apps/web's vitest suite never sets E2E_TEST_LOGIN, the same condition that must hold in
// any real deployment, so this proves the real route handler (not just the pure gate function
// in e2e-gate.test.ts) returns 404 in that state.
describe("POST /api/test/preview-token — e2e flag absent (the deployed/production condition)", () => {
  test("responds 404 for a request that looks like a legitimate localhost e2e call", async () => {
    const request = new Request("http://localhost:3100/api/test/preview-token", {
      method: "POST",
      headers: { host: "localhost:3100", "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const response = await POST(request as never);
    expect(response.status).toBe(404);
  });

  test("responds 404 even with no body", async () => {
    const request = new Request("http://localhost:3100/api/test/preview-token", { method: "POST" });
    const response = await POST(request as never);
    expect(response.status).toBe(404);
  });
});
