import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  buildStaffAuth,
  cleanupAuthTables,
  cleanupStaffUsers,
  createCommittedStaffUser,
} from "./setup";

// These tests mock Google at the exact HTTP/profile boundary Better Auth exposes for this
// purpose: `verifyIdToken` (normally checks the id token's signature against Google's JWKS) and
// `getUserInfo` (normally fetches the profile from Google's userinfo endpoint). Overriding both
// and calling `signInSocial` with an `idToken` body skips the authorization-code/token-exchange
// round trip entirely (confirmed by reading node_modules/better-auth/dist/api/routes/sign-in.mjs)
// — so these tests make zero real network calls, while still exercising the real `google`
// provider object and the real `validateUserInfo`/`databaseHooks` gates.

let staffUserIds: string[] = [];

beforeEach(() => {
  staffUserIds = [];
});

afterEach(async () => {
  await cleanupAuthTables();
  await cleanupStaffUsers(staffUserIds);
});

function stubGoogleProfile(email: string) {
  const now = Math.floor(Date.now() / 1000);
  return {
    user: { email, emailVerified: true, name: "Test Staff" },
    data: {
      sub: `google-${email}`,
      email,
      email_verified: true,
      name: "Test Staff",
      given_name: "Test",
      family_name: "Staff",
      picture: "https://example.test/avatar.png",
      aud: "test-client-id",
      azp: "test-client-id",
      iss: "https://accounts.google.com",
      iat: now,
      exp: now + 3600,
    },
  };
}

describe("Google sign-in — the staff gate", () => {
  test("an active staff member's first-ever Google login succeeds", async () => {
    const staff = await createCommittedStaffUser({ isActive: true });
    staffUserIds.push(staff.id);
    const { auth } = buildStaffAuth({
      google: {
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        verifyIdToken: async () => true,
        getUserInfo: async () => stubGoogleProfile(staff.email),
      },
    });

    const result = await auth.api.signInSocial({
      body: { provider: "google", idToken: { token: "stub-id-token" } },
    });
    if (!("user" in result)) throw new Error("expected an id-token sign-in response with a user");
    expect(result.user.email).toBe(staff.email.toLowerCase());
  });

  test("an unknown Google email is rejected", async () => {
    const { auth } = buildStaffAuth({
      google: {
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        verifyIdToken: async () => true,
        getUserInfo: async () => stubGoogleProfile("nobody@example.test"),
      },
    });

    await expect(
      auth.api.signInSocial({ body: { provider: "google", idToken: { token: "stub-id-token" } } }),
    ).rejects.toThrow();
  });

  test("an inactive staff member's Google login is rejected", async () => {
    const staff = await createCommittedStaffUser({ isActive: false });
    staffUserIds.push(staff.id);
    const { auth } = buildStaffAuth({
      google: {
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        verifyIdToken: async () => true,
        getUserInfo: async () => stubGoogleProfile(staff.email),
      },
    });

    await expect(
      auth.api.signInSocial({ body: { provider: "google", idToken: { token: "stub-id-token" } } }),
    ).rejects.toThrow();
  });
});
