import { isIP } from "node:net";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, createAuthMiddleware, formCsrfMiddleware, getIP, isAPIError } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { revokeUnprovenAccountAccess } from "better-auth/db";
import { auditLog, customers } from "@ammari/db/schema";
import type { Database } from "./customer-data";
import { consumeCustomerLoginLink, releaseConsumedLoginLink } from "./login-link";

// `orderLoginLink`: the "Masuk ke akun" login (docs/plans/cart-checkout.md §9.3, D15; session 14).
//
// Why a plugin and not Better Auth's stock `magic-link` (read from the installed 1.7.7 source): that
// plugin logs in on its GET verify URL (email scanners prefetch links), never invalidates older
// links, binds only an email, and exposes public issuance. This one has no issuance endpoint at all
// (links are issued by the order email step, ./login-link.ts) and one POST endpoint that logs in,
// inside Better Auth's own HTTP router, so its rate limiter and origin checks apply (SPEC §10.1 on
// why `.api` calls from server code would skip both).
//
// CSRF: Better Auth's `formCsrfMiddleware` (Fetch Metadata: refuses a cross-site navigation POST,
// validates Origin against `trustedOrigins`), and on top `requireTrustedOrigin`: the POST must carry
// an Origin header naming a trusted origin. The confirm page sends `Referrer-Policy: same-origin`
// (owner decision 2026-10-21, session 14; under `no-referrer` browsers send `Origin: null` on the
// page's own form POST), so a real browser always sends our exact origin here. Server-side `.api`
// calls carry no request and are refused too: this login only ever happens over HTTP.

export const ORDER_LOGIN_LINK_CONSUME_PATH = "/order-login-link/consume";
/** Plan §9.3: 10 consume attempts per 10 minutes per IP (Better Auth's limiter, CF-Connecting-IP). */
const CONSUME_RATE_LIMIT_WINDOW_SECONDS = 10 * 60;
const CONSUME_RATE_LIMIT_MAX = 10;

export interface OrderLoginLinkOptions {
  db: Database;
  /** Where a successful login lands, e.g. "/orders". */
  successPath: string;
  /** The confirm page; failures land on `<pagePath>?status=<reason>`. */
  pagePath: string;
}

/** Login link outcomes the confirm page shows. */
export type OrderLoginLinkStatus = "invalid" | "error";

const requireTrustedOrigin = createAuthMiddleware(async (ctx) => {
  const origin = ctx.request?.headers.get("origin");
  if (!origin || origin === "null" || !ctx.context.isTrustedOrigin(origin, { allowRelativePaths: false })) {
    console.warn("[order-login-link] login refused: missing or foreign Origin");
    throw APIError.fromStatus("FORBIDDEN", { message: "Invalid origin" });
  }
});

export function orderLoginLink(options: OrderLoginLinkOptions) {
  const { db, successPath, pagePath } = options;

  return {
    id: "order-login-link",
    endpoints: {
      consumeOrderLoginLink: createAuthEndpoint(
        ORDER_LOGIN_LINK_CONSUME_PATH,
        {
          method: "POST",
          requireHeaders: true,
          use: [formCsrfMiddleware, requireTrustedOrigin],
          // A plain HTML form posts this; Better Auth's router otherwise accepts JSON only.
          metadata: { allowedMediaTypes: ["application/x-www-form-urlencoded"] },
        },
        async (ctx) => {
          const redirectTo = (status: OrderLoginLinkStatus) => ctx.redirect(`${pagePath}?status=${status}`);
          const rawIp = ctx.request ? getIP(ctx.request, ctx.context.options) : null;
          const ip = rawIp && isIP(rawIp) ? rawIp : null;
          const body = ctx.body as Record<string, unknown> | undefined;

          // Kept outside the try so every failure after the consume can name the (now used) link.
          let consumed: { linkId: string; customerId: string } | null = null;
          let sessionCreated = false;
          try {
            const link = await consumeCustomerLoginLink(db, body?.token, ip);
            if (!link) {
              // Unknown, malformed, used, superseded, expired, or the customer's email changed since
              // it was sent: one generic answer. Never logs the token.
              console.warn("[order-login-link] login link refused: not usable");
              throw redirectTo("invalid");
            }
            consumed = { linkId: link.linkId, customerId: link.customerId };

            const email = link.email.toLowerCase();
            const found = await ctx.context.internalAdapter.findUserByEmail(email);
            // A first login creates the Better Auth user; the customer instance's
            // user.create.before hook links it to the customers row with this email, which is the
            // link's own customer (the consume re-checked the email).
            let user = found?.user ?? (await ctx.context.internalAdapter.createUser({ email, emailVerified: true, name: "" }, { method: "order-login-link" }));
            const userCustomerId = "customerId" in user ? user.customerId : undefined;
            if (userCustomerId !== link.customerId) {
              console.error("[order-login-link] login refused: the account for this email belongs to another customer; the link is used up", consumed);
              throw redirectTo("invalid");
            }
            if (!user.emailVerified) {
              // Same as Better Auth's own email OTP and magic link: the click proves the mailbox, so
              // access the account accrued before that proof is dropped and the email marked verified.
              const promoted = await revokeUnprovenAccountAccess(ctx, user.id);
              if (!promoted) throw new Error("the unverified account could not be promoted");
              user = promoted;
            }
            await db.update(customers).set({ emailVerifiedAt: sql`now()` }).where(and(eq(customers.id, link.customerId), isNull(customers.emailVerifiedAt)));

            // Same session, cookie and hooks as an OTP or Google login.
            const session = await ctx.context.internalAdapter.createSession(user.id);
            sessionCreated = true;
            await setSessionCookie(ctx, { session, user });

            try {
              await db.insert(auditLog).values({
                actorStaffUserId: null,
                action: "customer_login_link",
                entityType: "customer",
                entityId: link.customerId,
                after: { linkId: link.linkId, orderId: link.orderId, ip },
              });
            } catch (error) {
              // The session already exists; failing the login now would only strand the buyer.
              console.error("[order-login-link] logged in, but the audit row was not written", { ...consumed, orderId: link.orderId, name: error instanceof Error ? error.name : typeof error });
            }
            throw ctx.redirect(successPath);
          } catch (error) {
            if (isAPIError(error)) throw error;
            // A failure after the consume but before any session: give the link back, so a transient
            // database error does not use the buyer's link up.
            const released = consumed !== null && !sessionCreated ? await releaseConsumedLoginLink(db, consumed.linkId) : false;
            console.error("[order-login-link] login link failed", {
              ...consumed,
              stage: consumed === null ? "consume" : sessionCreated ? "after_session" : "before_session",
              linkReleased: released,
              name: error instanceof Error ? error.name : typeof error,
              code: (error as { code?: unknown } | null)?.code,
            });
            throw redirectTo("error");
          }
        },
      ),
    },
    rateLimit: [
      {
        pathMatcher: (path: string) => path === ORDER_LOGIN_LINK_CONSUME_PATH,
        window: CONSUME_RATE_LIMIT_WINDOW_SECONDS,
        max: CONSUME_RATE_LIMIT_MAX,
      },
    ],
  } satisfies BetterAuthPlugin;
}
