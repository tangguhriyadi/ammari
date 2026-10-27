import { describe, expect, test } from "vitest";
import { buildStaffInviteEmail } from "./invite-email";

describe("buildStaffInviteEmail", () => {
  const message = buildStaffInviteEmail({
    to: "rina+gudang@example.test",
    name: "Rina",
    roleName: "Admin Gudang",
    loginUrl: "https://admin.ammari.example",
    inviteExpiresAt: new Date("2026-11-03T07:30:00Z"),
    logoUrl: null,
    idempotencyKey: "invite-1",
  });
  const link = "https://admin.ammari.example/login?email=rina%2Bgudang%40example.test";

  test("the button, the written-out address and the plain text all open /login with the email prefilled", () => {
    const html = message.html ?? "";
    expect(html).toContain(`<a href="${link}"`);
    expect(html.split(link).length - 1).toBeGreaterThanOrEqual(2);
    expect(message.body).toContain(`Buka Admin Ammari:\n${link}`);
  });
});
