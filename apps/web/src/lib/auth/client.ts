"use client";

import { createAuthClient } from "better-auth/react";
import { emailOTPClient } from "better-auth/client/plugins";

// Talks to /api/auth/* over real HTTP (same-origin, no baseURL needed) — deliberately NOT
// customerAuth.api.* called from a server action. Going through the actual route handler is
// what makes Better Auth's own rate limiting and origin/CSRF check apply at all: both are wired
// into the HTTP router (see app/api/auth/[...all]/route.ts), not into the `.api` object, which
// bypasses that middleware entirely.
export const authClient = createAuthClient({
  plugins: [emailOTPClient()],
});
