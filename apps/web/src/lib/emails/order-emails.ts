import "server-only";
import { after } from "next/server";
import { ConsoleEmailSender, ResendEmailSender, type EmailSender } from "@ammari/auth";
import { issueOrReuseCustomerLoginLink } from "@ammari/auth/customer";
import { dispatchOrderEmails, type OrderEmailDeps } from "@ammari/commerce/emails";
import { errorLogFields } from "@ammari/commerce/errors";
import { defaultDb } from "@/lib/db";
import { siteOrigin } from "@/lib/site-origin";

// Order emails for apps/web (docs/plans/cart-checkout.md §8, session 13; the "Masuk ke akun" link
// since session 14). Every hook (checkout, the
// payment notification, the finish page's status check, the expiry sweep) schedules
// @ammari/commerce/emails' dispatcher with Next's `after()`, so it runs once the response is sent
// and outside every transaction: an email never delays, fails or rolls back a payment or an expiry.
// The dispatcher decides what is due from the order itself and sends each email at most once; the
// cron pass (POST /api/internal/emails/dispatch) retries failures and covers staff's "Tandai
// dikirim" in apps/admin.
//
// Without a usable configuration nothing is claimed (so nothing is lost): the cron pass sends what
// is still due once the variables are set. Problems are logged by variable name only.

const isE2eTestLoginEnabled = process.env.NODE_ENV !== "production" && process.env.E2E_TEST_LOGIN === "true";

/** e2e runs: delivered nowhere (like the OTP's CapturingEmailSender), still recorded as sent. */
const discardingSender: EmailSender = {
  async send() {},
};

/** At least this long in production, like INTERNAL_CRON_SECRET (lib/internal/cron-auth.ts). */
const MIN_LINK_SECRET_LENGTH = 32;

let senderForTests: EmailSender | null = null;

/** Test-only: the sender every dispatch uses (unit tests pass a ResendEmailSender over a stubbed
 * fetch); null restores the environment's choice. */
export function __setOrderEmailSenderForTests(sender: EmailSender | null): void {
  senderForTests = sender;
}

function emailSender(problems: string[]): EmailSender | null {
  if (senderForTests) return senderForTests;
  if (isE2eTestLoginEnabled) return discardingSender;
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.EMAIL_FROM?.trim();
  if (apiKey && from) return new ResendEmailSender({ apiKey, from });
  if (process.env.NODE_ENV !== "production") return new ConsoleEmailSender();
  problems.push("RESEND_API_KEY", "EMAIL_FROM");
  return null;
}

/** ADMIN_SITE_URL: apps/admin's public origin for the owner email's "Buka di admin" link
 * (optional; without it the owner email has no link). */
function adminOrigin(problems: string[]): string | null {
  const raw = process.env.ADMIN_SITE_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const schemes = process.env.NODE_ENV === "production" ? ["https:"] : ["https:", "http:"];
    if (!schemes.includes(url.protocol)) throw new Error("scheme");
    return url.origin;
  } catch {
    problems.push("ADMIN_SITE_URL");
    return null;
  }
}

/** The storefront origin for every link in a customer email. In production it must be set and https
 * (siteOrigin() falls back to localhost, which would send buyers dead links recorded as sent). */
function storefrontOrigin(problems: string[]): string | null {
  const origin = siteOrigin();
  if (process.env.NODE_ENV === "production" && (!process.env.BETTER_AUTH_URL?.trim() || !origin.startsWith("https://"))) {
    problems.push("BETTER_AUTH_URL");
    return null;
  }
  return origin;
}

let lastLoggedProblems: string | null = null;

export interface OrderEmailConfig {
  deps: OrderEmailDeps | null;
  /** Variable names with a problem (never values). ADMIN_SITE_URL alone only drops the admin link. */
  problems: string[];
}

/** The dispatcher's dependencies for this process (null when emails cannot be sent) and what is
 * wrong with the configuration. A new set of problems is logged once per process. */
export function getOrderEmailConfig(): OrderEmailConfig {
  const problems: string[] = [];
  const transport = emailSender(problems);
  const linkSecret = process.env.CUSTOMER_BETTER_AUTH_SECRET ?? "";
  if (!linkSecret || (process.env.NODE_ENV === "production" && linkSecret.length < MIN_LINK_SECRET_LENGTH)) problems.push("CUSTOMER_BETTER_AUTH_SECRET");
  const origin = storefrontOrigin(problems);
  const admin = adminOrigin(problems);
  const signature = problems.join("|");
  if (signature && signature !== lastLoggedProblems) console.error("[emails] order email configuration problem", { problems });
  lastLoggedProblems = signature || null;
  if (!transport || !origin || problems.includes("CUSTOMER_BETTER_AUTH_SECRET")) return { deps: null, problems };
  // "Masuk ke akun" in guest order emails (plan §9.3, session 14): the links live in the customer
  // auth instance's table; the dispatcher derives the token and decides when one may be issued.
  const loginLinks = { issueOrReuse: (input: Parameters<typeof issueOrReuseCustomerLoginLink>[1]) => issueOrReuseCustomerLoginLink(defaultDb, input) };
  return { deps: { transport, siteOrigin: origin, adminOrigin: admin, linkSecret, loginLinks }, problems };
}

export function getOrderEmailDeps(): OrderEmailDeps | null {
  return getOrderEmailConfig().deps;
}

type OrderRef = { orderId: string } | { orderNo: string };

/** Sends what the orders need once this response is finished. Never throws into the caller, and the
 * callback never rejects (dispatchOrderEmails itself never throws). */
export function scheduleOrderEmails(refs: OrderRef[], source: string): void {
  if (refs.length === 0) return;
  try {
    after(async () => {
      try {
        const deps = getOrderEmailDeps();
        if (!deps) {
          console.warn("[emails] order emails not sent now (not configured); the cron pass sends them once it is", { source });
          return;
        }
        for (const ref of refs) {
          const dispatched = await dispatchOrderEmails(defaultDb, deps, ref);
          const unsent = dispatched.results.filter((result) => result.outcome !== "sent");
          if (unsent.length > 0) console.warn("[emails] some order emails were not sent", { source, orderNo: dispatched.orderNo, unsent });
        }
      } catch (error) {
        console.error("[emails] order email hook failed; the cron pass retries", { source, ...errorLogFields(error) });
      }
    });
  } catch (error) {
    // Outside a request scope (should not happen): the cron pass sends them instead.
    console.error("[emails] could not schedule order emails; the cron pass sends them", { source, ...errorLogFields(error) });
  }
}
