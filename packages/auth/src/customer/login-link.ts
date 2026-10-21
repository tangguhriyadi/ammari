import { createHash } from "node:crypto";
import { and, count, eq, gt, isNull, sql } from "drizzle-orm";
import { customerLoginLinks, customers } from "@ammari/db/schema";
import { qualifiedColumn } from "@ammari/db/sql-helpers";
import type { Database as Client } from "./customer-data";

/** The client or one of its transactions (the order email step and tests call these inside one). */
type Database = Client | Parameters<Parameters<Client["transaction"]>[0]>[0];

// "Masuk ke akun" one-time login links (docs/plans/cart-checkout.md §9.3, D15; session 14).
//
// The raw token is never stored: only its sha256 (hex) sits in `customer_login_links`. Issuance is
// server-side only (the order email step, through `issueOrReuseCustomerLoginLink`); there is no
// endpoint that issues a link. Opening the link's page only reads (`findLiveCustomerLoginLink`);
// logging in is the plugin's POST, which consumes the link with one atomic UPDATE ... RETURNING
// (`consumeCustomerLoginLink`).

/** A link logs in within this many hours of being issued. */
export const LOGIN_LINK_TTL_HOURS = 24;
/** At most this many links are issued per customer per 24 hours (owner decision 2026-10-21,
 * session 14: this per-customer cap is the only limit; the OTP email throttle is never written, so an
 * order email can never delay the buyer's own login code). */
export const LOGIN_LINK_MAX_PER_DAY = 5;

// 32 bytes in unpadded base64url (the order email derives it with HMAC-SHA256) is 43 characters.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Anything else (tampered, truncated) is treated as no token, so an arbitrary string is never
 * hashed and looked up. */
export function isWellFormedLoginLinkToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

export function hashLoginLinkToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** "a***@gmail.com": enough for the owner of the address to recognize it, not enough for anyone
 * who only holds the link to learn it. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "***";
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

export interface IssueLoginLinkInput {
  /** The raw token the email will carry (derived by the caller, so a retried email is identical). */
  token: string;
  customerId: string;
  /** The address the email goes to; a link is issued only while it is the customer's own email. */
  email: string;
  orderId: string | null;
  /** false on a retried email: an existing link (by hash) is still reused, but no new one is
   * issued, so a payload already handed to the email provider never changes. */
  mayIssue: boolean;
}

export type IssueLoginLinkResult =
  /** A new link was issued (the customer's previous live link, if any, is superseded). */
  | "issued"
  /** This exact token was issued before (a retry of the same email). */
  | "existing"
  /** Not issued: a retry whose first attempt issued nothing. */
  | "not_issued"
  /** Not issued: the address is no longer (or never was) the customer's email. */
  | "email_mismatch"
  /** Not issued: LOGIN_LINK_MAX_PER_DAY reached. */
  | "limited";

/** Returns whether the email may carry the link (`issued` / `existing`) and why not otherwise.
 *
 * One transaction with the customer row locked FOR UPDATE, so concurrent issuances for the same
 * customer run one after the other: the cap count, superseding the live link and inserting the new
 * one can never interleave (CLAUDE.md: never check-then-write without a lock). The partial UNIQUE
 * index `customer_login_links_live_customer_id_key` backs the "one live link" rule in the database
 * either way. */
export async function issueOrReuseCustomerLoginLink(db: Database, input: IssueLoginLinkInput): Promise<IssueLoginLinkResult> {
  if (!isWellFormedLoginLinkToken(input.token)) throw new Error("login link token is not well formed");
  const tokenHash = hashLoginLinkToken(input.token);

  const [existing] = await db.select({ id: customerLoginLinks.id }).from(customerLoginLinks).where(eq(customerLoginLinks.tokenHash, tokenHash)).limit(1);
  if (existing) return "existing";
  if (!input.mayIssue) return "not_issued";

  return db.transaction(async (tx) => {
    const [customer] = await tx
      .select({ id: customers.id, email: customers.email })
      .from(customers)
      .where(and(eq(customers.id, input.customerId), eq(customers.email, input.email)))
      .for("no key update");
    if (!customer?.email) return "email_mismatch";

    const [recent] = await tx
      .select({ issued: count() })
      .from(customerLoginLinks)
      .where(and(eq(customerLoginLinks.customerId, customer.id), gt(customerLoginLinks.createdAt, sql`now() - make_interval(hours => 24)`)));
    if ((recent?.issued ?? 0) >= LOGIN_LINK_MAX_PER_DAY) return "limited";

    await tx
      .update(customerLoginLinks)
      .set({ supersededAt: sql`now()` })
      .where(and(eq(customerLoginLinks.customerId, customer.id), isNull(customerLoginLinks.consumedAt), isNull(customerLoginLinks.supersededAt)));
    const inserted = await tx
      .insert(customerLoginLinks)
      .values({
        customerId: customer.id,
        email: customer.email,
        tokenHash,
        orderId: input.orderId,
        expiresAt: sql`now() + make_interval(hours => ${LOGIN_LINK_TTL_HOURS})`,
      })
      .onConflictDoNothing({ target: customerLoginLinks.tokenHash })
      .returning({ id: customerLoginLinks.id });
    return inserted.length > 0 ? "issued" : "existing";
  });
}

/** The rule a link must meet to log in, shared by the read-only page lookup and the consume:
 * unused, not superseded, not expired, and the customer still has the address it was sent to. */
function liveLinkCondition(tokenHash: string) {
  return sql`${customerLoginLinks.tokenHash} = ${tokenHash}
    and ${customerLoginLinks.consumedAt} is null
    and ${customerLoginLinks.supersededAt} is null
    and ${customerLoginLinks.expiresAt} > now()
    and ${qualifiedColumn(customers, customers.id)} = ${qualifiedColumn(customerLoginLinks, customerLoginLinks.customerId)}
    and ${qualifiedColumn(customers, customers.email)} = ${qualifiedColumn(customerLoginLinks, customerLoginLinks.email)}`;
}

export interface LiveLoginLink {
  customerId: string;
  /** e.g. "a***@gmail.com". */
  maskedEmail: string;
}

/** Read-only (the GET page): never consumes, so mail scanners and link prefetchers that open the
 * page change nothing. Null for a malformed, unknown, used, superseded or expired token. */
export async function findLiveCustomerLoginLink(db: Database, token: unknown): Promise<LiveLoginLink | null> {
  if (!isWellFormedLoginLinkToken(token)) return null;
  const [row] = await db
    .select({ customerId: customerLoginLinks.customerId, email: customerLoginLinks.email })
    .from(customerLoginLinks)
    .innerJoin(customers, eq(customers.id, customerLoginLinks.customerId))
    .where(liveLinkCondition(hashLoginLinkToken(token)))
    .limit(1);
  return row ? { customerId: row.customerId, maskedEmail: maskEmail(row.email) } : null;
}

export interface ConsumedLoginLink {
  linkId: string;
  customerId: string;
  email: string;
  orderId: string | null;
}

/** Uses the link up, atomically: one UPDATE ... FROM customers ... RETURNING, so two concurrent
 * POSTs of the same token can never both succeed, and a link whose customer changed email since it
 * was sent never logs in. `ip` must already be a valid address or null (stored as `inet`). */
export async function consumeCustomerLoginLink(db: Database, token: unknown, ip: string | null): Promise<ConsumedLoginLink | null> {
  if (!isWellFormedLoginLinkToken(token)) return null;
  const [row] = await db
    .update(customerLoginLinks)
    .set({ consumedAt: sql`now()`, consumedIp: ip })
    .from(customers)
    .where(liveLinkCondition(hashLoginLinkToken(token)))
    .returning({ linkId: customerLoginLinks.id, customerId: customerLoginLinks.customerId, email: customerLoginLinks.email, orderId: customerLoginLinks.orderId });
  return row ?? null;
}

/** Undoes a consume whose login then failed before any session existed (a database error while
 * creating the user or session), so a transient failure does not use the buyer's link up. If a newer
 * link was issued meanwhile, the partial UNIQUE index refuses the release and the link stays used.
 * Never throws; returns whether the link is usable again. */
export async function releaseConsumedLoginLink(db: Database, linkId: string): Promise<boolean> {
  try {
    const rows = await db
      .update(customerLoginLinks)
      .set({ consumedAt: null, consumedIp: null })
      .where(and(eq(customerLoginLinks.id, linkId), sql`${customerLoginLinks.consumedAt} is not null`, isNull(customerLoginLinks.supersededAt)))
      .returning({ id: customerLoginLinks.id });
    return rows.length > 0;
  } catch {
    return false;
  }
}
