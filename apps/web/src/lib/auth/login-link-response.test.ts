import { describe, expect, test } from "vitest";
import { mapLoginLinkRefusal } from "./login-link-response";

const consume = new Request("http://localhost:3000/api/auth/order-login-link/consume", { method: "POST" });

describe("mapLoginLinkRefusal", () => {
  test.each([
    [429, "limited"],
    [403, "blocked"],
    [415, "error"],
    [500, "error"],
  ])("a %i from the login link POST goes back to the confirm page as %s", (status, mapped) => {
    const response = mapLoginLinkRefusal(consume, new Response("{}", { status }));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/login/link?status=${mapped}`);
  });

  test("the plugin's own redirects and every other auth endpoint pass through", () => {
    const redirect = new Response(null, { status: 302, headers: { location: "/account" } });
    expect(mapLoginLinkRefusal(consume, redirect)).toBe(redirect);
    const otp = new Response("{}", { status: 429 });
    expect(mapLoginLinkRefusal(new Request("http://localhost:3000/api/auth/sign-in/email-otp", { method: "POST" }), otp)).toBe(otp);
  });
});
