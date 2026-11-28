import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { tiktokOauthStates, tiktokShopConnections, type TikTokConnectionStatus } from "@ammari/db/schema";
import {
  Secret,
  TikTokApiError,
  TokenDecryptError,
  decryptToken,
  encryptToken,
  type TikTokAuthClient,
  type TikTokAuthorizedShop,
  type TikTokTokenSet,
  type TokenKeyring,
} from "@ammari/tiktok-shop";
import { writeAuditLog, type Database, type Tx } from "../db";
import { TIKTOK_OAUTH_STATE_TTL_MS, tiktokRefreshDue } from "./status";

// The TikTok Shop connection's write paths (docs/plans/tiktok-shop-integration.md §3.1, §7.2, §7.3).
// Tokens are encrypted before they reach a query and decrypted only to be sent to TikTok; no
// function here logs, and no audit row carries a token, a code or a state. Every concurrent path is
// a lock plus a conditional UPDATE ... RETURNING, never a check followed by a separate write
// (CLAUDE.md):
//   - OAuth state: one UPDATE consumes it (unused, unexpired, same staff user).
//   - Connect / disconnect: `pg_advisory_xact_lock(hashtext('tiktok-connection'))`.
//   - Refresh: `pg_advisory_xact_lock(hashtext('tiktok-token'))`, and the write is conditional on
//     the `token_generation` read under that lock, so two refreshers never both rotate.
//   - Deauthorization / expiry warning (topics 6 and 7, delivered by T3's webhook): one
//     conditional UPDATE each.

const ENTITY_TYPE = "tiktok_shop_connection";
const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** Expired states are kept a day (debugging a failed connect), then removed on the next start. */
const STATE_CLEANUP_AFTER_MS = 24 * 60 * 60 * 1000;
const LOCK_TIMEOUT = "20s";
/** Topics 6/7 wait at most this long behind a token refresh holding the row (its TikTok call); a
 * timeout (55P03) is retried by the inbox, never queued on the shared pool. */
const EVENT_LOCK_TIMEOUT = "3s";
/** TikTok's event `timestamp` has one-second resolution and its own clock: an event up to this much
 * before `connected_at` still counts as being about the current authorization. */
export const TIKTOK_EVENT_CLOCK_TOLERANCE_MS = 60_000;

/** The latest `connected_at` an event at `at` may act on (see TIKTOK_EVENT_CLOCK_TOLERANCE_MS). */
export function tiktokEventConnectedBefore(at: Date): Date {
  return new Date(at.getTime() + TIKTOK_EVENT_CLOCK_TOLERANCE_MS);
}

type ConnectionRow = typeof tiktokShopConnections.$inferSelect;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** What an audit row may say about a connection: never a token, a cipher or a key. */
function auditSummary(row: ConnectionRow) {
  return {
    shopId: row.shopId,
    shopName: row.shopName,
    status: row.status,
    grantedScopes: row.grantedScopes,
    accessTokenExpiresAt: row.accessTokenExpiresAt?.toISOString() ?? null,
    refreshTokenExpiresAt: row.refreshTokenExpiresAt?.toISOString() ?? null,
    tokenGeneration: row.tokenGeneration,
  };
}

function encryptPair(tokens: Pick<TikTokTokenSet, "accessToken" | "refreshToken">, keyring: TokenKeyring, connectionId: string) {
  return {
    accessTokenCt: encryptToken(tokens.accessToken, keyring, { connectionId, column: "access_token_ct" }),
    refreshTokenCt: encryptToken(tokens.refreshToken, keyring, { connectionId, column: "refresh_token_ct" }),
    tokenKeyVersion: keyring.currentVersion,
  };
}

/** Both locks live in their own two-key namespace, so they can never collide with the repo's
 * single-key `hashtext(...)` locks (order numbers, import, ledger months). `lock_timeout` bounds the
 * wait behind a refresh that holds the row during its TikTok call; a timeout surfaces as Postgres
 * 55P03 (lock_not_available). */
async function lock(tx: Tx, name: "tiktok-connection" | "tiktok-token"): Promise<void> {
  await tx.execute(sql.raw(`set local lock_timeout = '${LOCK_TIMEOUT}'`));
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('ammari.tiktok'), hashtext(${name}))`);
}

function isLockTimeout(error: unknown): boolean {
  const cause = (error instanceof Error ? (error.cause ?? error) : null) as { code?: unknown } | null;
  return cause?.code === "55P03";
}

// ---- OAuth state ------------------------------------------------------------------------------

/** Starts a connection: a fresh 32-byte state for the authorize link. Only its SHA-256 is stored;
 * the raw value is returned once, wrapped so it cannot be logged by accident. */
export async function createTikTokOAuthState(db: Database, staffUserId: string, now: Date = new Date()): Promise<Secret> {
  const raw = randomBytes(32).toString("base64url");
  await db.transaction(async (tx) => {
    await tx.delete(tiktokOauthStates).where(lt(tiktokOauthStates.expiresAt, new Date(now.getTime() - STATE_CLEANUP_AFTER_MS)));
    await tx.insert(tiktokOauthStates).values({
      stateHash: sha256Hex(raw),
      staffUserId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + TIKTOK_OAUTH_STATE_TTL_MS),
    });
  });
  return new Secret(raw);
}

/** True exactly once per state: unused, unexpired, and started by this staff user. One atomic
 * UPDATE, so two concurrent callbacks with the same state cannot both pass. */
export async function consumeTikTokOAuthState(db: Database, rawState: string, staffUserId: string, now: Date = new Date()): Promise<boolean> {
  if (!STATE_PATTERN.test(rawState)) return false;
  const rows = await db
    .update(tiktokOauthStates)
    .set({ usedAt: now })
    .where(
      and(
        eq(tiktokOauthStates.stateHash, sha256Hex(rawState)),
        isNull(tiktokOauthStates.usedAt),
        gt(tiktokOauthStates.expiresAt, now),
        eq(tiktokOauthStates.staffUserId, staffUserId),
      ),
    )
    .returning({ stateHash: tiktokOauthStates.stateHash });
  return rows.length === 1;
}

// ---- Connect / disconnect ---------------------------------------------------------------------

export type SaveTikTokConnectionResult =
  | { ok: true; connectionId: string; reconnected: boolean }
  /** Another shop is connected and active. v1 supports one shop: it must be disconnected first. */
  | { ok: false; reason: "other_shop_active" };

export interface SaveTikTokConnectionInput {
  tokens: TikTokTokenSet;
  shop: TikTokAuthorizedShop;
  staffUserId: string;
  keyring: TokenKeyring;
  now?: Date;
}

/** Stores a fresh authorization (the OAuth callback, §7.3 step 2). The same shop again is a
 * reconnect: new tokens, `active`, warnings cleared, `token_generation` + 1 (so a refresh that read
 * the old tokens cannot overwrite these). Another shop's leftover `reauth_required` row is
 * disconnected (tokens wiped) so at most one connection is ever current. */
export async function saveTikTokConnection(db: Database, input: SaveTikTokConnectionInput): Promise<SaveTikTokConnectionResult> {
  const now = input.now ?? new Date();
  const { tokens, shop, keyring, staffUserId } = input;
  return db.transaction(async (tx) => {
    await lock(tx, "tiktok-connection");
    const [otherActive] = await tx
      .select({ id: tiktokShopConnections.id })
      .from(tiktokShopConnections)
      .where(and(eq(tiktokShopConnections.status, "active"), ne(tiktokShopConnections.shopId, shop.shopId)));
    if (otherActive) return { ok: false, reason: "other_shop_active" } as const;

    const stale = await tx
      .update(tiktokShopConnections)
      .set({ status: "disconnected", accessTokenCt: null, refreshTokenCt: null })
      .where(and(eq(tiktokShopConnections.status, "reauth_required"), ne(tiktokShopConnections.shopId, shop.shopId)))
      .returning();
    for (const row of stale) {
      await writeAuditLog(tx, {
        actorStaffUserId: staffUserId,
        action: "tiktok_disconnect",
        entityType: ENTITY_TYPE,
        entityId: row.id,
        before: { ...auditSummary(row), status: "reauth_required" },
        after: { ...auditSummary(row), reason: "replaced_by_other_shop" },
      });
    }

    const [existing] = await tx.select().from(tiktokShopConnections).where(eq(tiktokShopConnections.shopId, shop.shopId)).for("update");
    const connectionId = existing?.id ?? randomUUID();
    const fields = {
      shopCipher: shop.shopCipher,
      shopName: shop.shopName,
      region: shop.region,
      sellerType: shop.sellerType,
      status: "active" as const,
      ...encryptPair(tokens, keyring, connectionId),
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
      grantedScopes: tokens.grantedScopes,
      connectedByStaffUserId: staffUserId,
      connectedAt: now,
      lastRefreshedAt: null,
      deauthorizedAt: null,
      expiryWarningAt: null,
      lastErrorCode: null,
      lastErrorAt: null,
    };

    let saved: ConnectionRow | undefined;
    if (existing) {
      [saved] = await tx
        .update(tiktokShopConnections)
        .set({ ...fields, tokenGeneration: sql`${tiktokShopConnections.tokenGeneration} + 1` })
        .where(and(eq(tiktokShopConnections.id, existing.id), eq(tiktokShopConnections.tokenGeneration, existing.tokenGeneration)))
        .returning();
    } else {
      [saved] = await tx
        .insert(tiktokShopConnections)
        .values({ id: connectionId, shopId: shop.shopId, ...fields })
        .returning();
    }
    if (!saved) throw new Error("tiktok connection: the connection row changed while saving");

    await writeAuditLog(tx, {
      actorStaffUserId: staffUserId,
      action: existing ? "tiktok_reconnect" : "tiktok_connect",
      entityType: ENTITY_TYPE,
      entityId: saved.id,
      before: existing ? auditSummary(existing) : null,
      after: auditSummary(saved),
    });
    return { ok: true, connectionId: saved.id, reconnected: existing !== undefined } as const;
  });
}

/** "Putuskan" (staff): wipes the tokens and stops sync. Phase 1 is read-only towards TikTok
 * (Q15), so the app's authorization in Seller Center stays until the seller removes it there. */
export async function disconnectTikTokShop(db: Database, input: { staffUserId: string; now?: Date }): Promise<{ ok: true; shopId: string } | { ok: false; reason: "not_connected" }> {
  return db.transaction(async (tx) => {
    await lock(tx, "tiktok-connection");
    const before = await tx
      .select()
      .from(tiktokShopConnections)
      .where(inArray(tiktokShopConnections.status, ["active", "reauth_required"]))
      .for("update");
    if (before.length === 0) return { ok: false, reason: "not_connected" } as const;
    const rows = await tx
      .update(tiktokShopConnections)
      .set({ status: "disconnected", accessTokenCt: null, refreshTokenCt: null })
      .where(inArray(tiktokShopConnections.status, ["active", "reauth_required"]))
      .returning();
    for (const row of rows) {
      const previous = before.find((candidate) => candidate.id === row.id);
      await writeAuditLog(tx, {
        actorStaffUserId: input.staffUserId,
        action: "tiktok_disconnect",
        entityType: ENTITY_TYPE,
        entityId: row.id,
        before: previous ? auditSummary(previous) : null,
        after: auditSummary(row),
      });
    }
    return { ok: true, shopId: rows[0]!.shopId } as const;
  });
}

// ---- Deauthorization and upcoming expiry (topics 6 and 7) -------------------------------------

/** Topic 6 (SELLER_DEAUTHORIZATION): wipe the tokens, `deauthorized`, sync stops, red banner.
 * Idempotent: a redelivered event changes nothing. False when the shop is unknown or already
 * stopped, or when the shop was (re)connected after `at` (beyond TIKTOK_EVENT_CLOCK_TOLERANCE_MS): a
 * deauthorization delivered late (TikTok retries for up to 12 hours, the inbox retries too) must
 * never wipe a newer authorization. Waits at most EVENT_LOCK_TIMEOUT for the row. */
export async function deauthorizeTikTokShop(db: Database, input: { shopId: string; at: Date }): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`set local lock_timeout = '${EVENT_LOCK_TIMEOUT}'`));
    const [before] = await tx
      .select()
      .from(tiktokShopConnections)
      .where(
        and(
          eq(tiktokShopConnections.shopId, input.shopId),
          inArray(tiktokShopConnections.status, ["active", "reauth_required"]),
          lte(tiktokShopConnections.connectedAt, tiktokEventConnectedBefore(input.at)),
        ),
      )
      .for("update");
    if (!before) return false;
    const [row] = await tx
      .update(tiktokShopConnections)
      .set({ status: "deauthorized", accessTokenCt: null, refreshTokenCt: null, deauthorizedAt: input.at })
      .where(
        and(
          eq(tiktokShopConnections.id, before.id),
          inArray(tiktokShopConnections.status, ["active", "reauth_required"]),
          lte(tiktokShopConnections.connectedAt, tiktokEventConnectedBefore(input.at)),
        ),
      )
      .returning();
    if (!row) return false;
    await writeAuditLog(tx, {
      actorStaffUserId: null,
      action: "tiktok_deauthorize",
      entityType: ENTITY_TYPE,
      entityId: row.id,
      before: auditSummary(before),
      after: auditSummary(row),
    });
    return true;
  });
}

/** Topic 7 (UPCOMING_AUTHORIZATION_EXPIRATION): records when it arrived, so the banner asks for a
 * reconnect. A reconnect clears it. Only a newer warning is recorded (redeliveries are no-ops), and
 * never one from before the current authorization (a late delivery about the old one). */
export async function recordTikTokExpiryWarning(db: Database, input: { shopId: string; at: Date }): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`set local lock_timeout = '${EVENT_LOCK_TIMEOUT}'`));
    const [row] = await tx
      .update(tiktokShopConnections)
      .set({ expiryWarningAt: input.at })
      .where(
        and(
          eq(tiktokShopConnections.shopId, input.shopId),
          inArray(tiktokShopConnections.status, ["active", "reauth_required"]),
          lte(tiktokShopConnections.connectedAt, tiktokEventConnectedBefore(input.at)),
          or(isNull(tiktokShopConnections.expiryWarningAt), lt(tiktokShopConnections.expiryWarningAt, input.at)),
        ),
      )
      .returning();
    if (!row) return false;
    await writeAuditLog(tx, {
      actorStaffUserId: null,
      action: "tiktok_expiry_warning",
      entityType: ENTITY_TYPE,
      entityId: row.id,
      after: { ...auditSummary(row), expiryWarningAt: input.at.toISOString() },
    });
    return true;
  });
}

// ---- Tokens -----------------------------------------------------------------------------------

export type TikTokReauthReason = "refresh_token_expired" | "refresh_rejected" | "token_decrypt_failed";

async function markReauthRequired(tx: Tx, row: ConnectionRow, reason: TikTokReauthReason, now: Date): Promise<void> {
  const [updated] = await tx
    .update(tiktokShopConnections)
    .set({ status: "reauth_required", lastErrorCode: reason, lastErrorAt: now })
    // Only the generation this caller read: a reconnect that committed fresh tokens meanwhile
    // (generation + 1) must never be flagged by a reader that saw the old ones.
    .where(and(eq(tiktokShopConnections.id, row.id), eq(tiktokShopConnections.status, "active"), eq(tiktokShopConnections.tokenGeneration, row.tokenGeneration)))
    .returning();
  if (!updated) return;
  await writeAuditLog(tx, {
    actorStaffUserId: null,
    action: "tiktok_reauth_required",
    entityType: ENTITY_TYPE,
    entityId: row.id,
    before: auditSummary(row),
    after: { ...auditSummary(updated), reason },
  });
}

/** A short, loggable error code for `last_error_code`: TikTok's numeric code when there is one,
 * else the error kind. Never a message or a body. */
export function tiktokErrorCode(error: TikTokApiError): string {
  return error.code !== null ? `${error.kind}:${error.code}` : error.kind;
}

export interface TikTokCredentials {
  connectionId: string;
  shopId: string;
  shopCipher: string;
  accessToken: Secret;
  tokenGeneration: number;
}

export type TikTokCredentialsResult = { ok: true; credentials: TikTokCredentials } | { ok: false; reason: "not_connected" | "reauth_required" };

/** The active connection's access token, for API calls (T4 onwards). A value that does not decrypt
 * (tampered, wrong key) fails closed: `reauth_required`, never a crash loop (§7.2). */
export async function loadTikTokCredentials(db: Database, keyring: TokenKeyring, now: Date = new Date()): Promise<TikTokCredentialsResult> {
  const [row] = await db.select().from(tiktokShopConnections).where(eq(tiktokShopConnections.status, "active"));
  if (!row || !row.accessTokenCt) return { ok: false, reason: "not_connected" };
  try {
    const accessToken = decryptToken(row.accessTokenCt, keyring, { connectionId: row.id, column: "access_token_ct" });
    return { ok: true, credentials: { connectionId: row.id, shopId: row.shopId, shopCipher: row.shopCipher, accessToken, tokenGeneration: row.tokenGeneration } };
  } catch (error) {
    if (!(error instanceof TokenDecryptError)) throw error;
    await db.transaction((tx) => markReauthRequired(tx, row, "token_decrypt_failed", now));
    return { ok: false, reason: "reauth_required" };
  }
}

export type RefreshTikTokTokenOutcome =
  | { kind: "not_connected" }
  /** More than 24 h left and not forced: nothing to do. */
  | { kind: "not_due"; tokenGeneration: number }
  | { kind: "refreshed"; tokenGeneration: number }
  /** The caller saw an older generation: another refresher already rotated the tokens. */
  | { kind: "already_refreshed"; tokenGeneration: number }
  | { kind: "reauth_required"; reason: TikTokReauthReason }
  /** TikTok could not refresh right now (network, 5xx, rate limit, or a refusal while the access
   * token is still valid). Status unchanged; `last_error_code` set; the next run tries again. */
  | { kind: "failed"; errorCode: string };

export interface RefreshTikTokTokenDeps {
  auth: TikTokAuthClient;
  keyring: TokenKeyring;
  now?: () => Date;
}

export interface RefreshTikTokTokenOptions {
  /** Refresh even with more than 24 h left (an auth error on an API call, §7.3 step 4). */
  force?: boolean;
  /** The `token_generation` the caller's failing request used. If it changed, another refresher
   * already rotated: no second TikTok call. */
  seenGeneration?: number;
}

/** Refreshes the active connection's tokens when due (< 24 h left) or forced, under the
 * `tiktok-token` advisory lock. Concurrent callers queue on the lock; the second one finds the
 * tokens fresh (or the generation moved) and makes no TikTok call. The write is conditional on the
 * generation read under the lock. */
export async function refreshTikTokToken(db: Database, deps: RefreshTikTokTokenDeps, options: RefreshTikTokTokenOptions = {}): Promise<RefreshTikTokTokenOutcome> {
  const clock = deps.now ?? (() => new Date());
  try {
    return await refreshUnderLock(db, deps, options, clock);
  } catch (error) {
    // Another refresher held the lock past lock_timeout: nothing changed, the next run retries.
    if (isLockTimeout(error)) return { kind: "failed", errorCode: "lock_timeout" };
    throw error;
  }
}

async function refreshUnderLock(db: Database, deps: RefreshTikTokTokenDeps, options: RefreshTikTokTokenOptions, clock: () => Date): Promise<RefreshTikTokTokenOutcome> {
  return db.transaction(async (tx): Promise<RefreshTikTokTokenOutcome> => {
    await lock(tx, "tiktok-token");
    const [row] = await tx.select().from(tiktokShopConnections).where(eq(tiktokShopConnections.status, "active")).for("update");
    if (!row || !row.refreshTokenCt) return { kind: "not_connected" };
    if (options.seenGeneration !== undefined && row.tokenGeneration !== options.seenGeneration) {
      return { kind: "already_refreshed", tokenGeneration: row.tokenGeneration };
    }
    const now = clock();
    if (!options.force && !tiktokRefreshDue(row.accessTokenExpiresAt, now)) return { kind: "not_due", tokenGeneration: row.tokenGeneration };

    if (row.refreshTokenExpiresAt && row.refreshTokenExpiresAt.getTime() <= now.getTime()) {
      await markReauthRequired(tx, row, "refresh_token_expired", now);
      return { kind: "reauth_required", reason: "refresh_token_expired" };
    }

    let refreshToken: Secret;
    try {
      refreshToken = decryptToken(row.refreshTokenCt, deps.keyring, { connectionId: row.id, column: "refresh_token_ct" });
    } catch (error) {
      if (!(error instanceof TokenDecryptError)) throw error;
      await markReauthRequired(tx, row, "token_decrypt_failed", now);
      return { kind: "reauth_required", reason: "token_decrypt_failed" };
    }

    // Known, accepted gap: TikTok may rotate the refresh token on this call. If the write below or
    // the commit then fails, the new tokens are lost with the rollback and the old refresh token
    // may no longer work; the connection then ends as reauth_required (visible) and the owner
    // reconnects. Under the row lock the write itself has no expected failure path.
    let tokens: TikTokTokenSet;
    try {
      tokens = await deps.auth.refreshAccessToken(refreshToken);
    } catch (error) {
      if (!(error instanceof TikTokApiError)) throw error;
      // TikTok's error fields only (toJSON: kind, path, status, code, request id and, on an
      // invalid_response, the `detail` naming the field or expiry). `last_error_code` keeps the short
      // `kind:code`; this line is where the cause is read (T0).
      console.warn("[tiktok-refresh] failed", error.toJSON());
      const errorCode = tiktokErrorCode(error);
      const accessExpired = row.accessTokenExpiresAt === null || row.accessTokenExpiresAt.getTime() <= now.getTime();
      // TikTok's codes for "refresh token invalid" are not among the confirmed facts (§0), so a
      // refusal is only final once the access token is gone too; before that it is retried.
      if (error.kind === "api" && accessExpired) {
        await markReauthRequired(tx, row, "refresh_rejected", now);
        return { kind: "reauth_required", reason: "refresh_rejected" };
      }
      await tx
        .update(tiktokShopConnections)
        .set({ lastErrorCode: errorCode, lastErrorAt: now })
        .where(eq(tiktokShopConnections.id, row.id));
      return { kind: "failed", errorCode };
    }

    // An optional field TikTok sent in an unusable shape was dropped by the auth client (names only).
    // A dropped scope means the list is incomplete, so it must not replace the one granted at connect
    // (the finance scope would vanish silently).
    const dropped = tokens.droppedFields ?? [];
    if (dropped.length > 0) console.warn("[tiktok-refresh] token fields dropped", { droppedFields: dropped });
    const scopesComplete = !dropped.includes("granted_scopes");

    const [updated] = await tx
      .update(tiktokShopConnections)
      .set({
        ...encryptPair(tokens, deps.keyring, row.id),
        accessTokenExpiresAt: tokens.accessTokenExpiresAt,
        refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
        // An answer without scopes, or with a scope dropped, keeps the ones granted at connect.
        grantedScopes: scopesComplete && tokens.grantedScopes.length > 0 ? tokens.grantedScopes : row.grantedScopes,
        tokenGeneration: sql`${tiktokShopConnections.tokenGeneration} + 1`,
        lastRefreshedAt: now,
        lastErrorCode: null,
        lastErrorAt: null,
      })
      .where(and(eq(tiktokShopConnections.id, row.id), eq(tiktokShopConnections.status, "active"), eq(tiktokShopConnections.tokenGeneration, row.tokenGeneration)))
      .returning();
    if (!updated) throw new Error("tiktok token refresh: the connection changed under the lock");
    await writeAuditLog(tx, {
      actorStaffUserId: null,
      action: "tiktok_token_refresh",
      entityType: ENTITY_TYPE,
      entityId: row.id,
      before: auditSummary(row),
      after: auditSummary(updated),
    });
    return { kind: "refreshed", tokenGeneration: updated.tokenGeneration };
  });
}

/** For `TikTokRequest.onAuthError`: one forced refresh for the generation the failing request used,
 * then the current access token. A connection that needs a reconnect throws `reauth_required`
 * (the client passes it through); a transient failure throws a plain error (`refresh_failed`). */
export function tiktokAuthErrorRefresher(db: Database, deps: RefreshTikTokTokenDeps, seenGeneration: number, path: string): () => Promise<Secret> {
  return async () => {
    const outcome = await refreshTikTokToken(db, deps, { force: true, seenGeneration });
    if (outcome.kind === "reauth_required" || outcome.kind === "not_connected") {
      throw new TikTokApiError({ kind: "reauth_required", path, httpStatus: null, code: null, requestId: null });
    }
    if (outcome.kind === "failed") throw new Error(`tiktok token refresh failed: ${outcome.errorCode}`);
    const credentials = await loadTikTokCredentials(db, deps.keyring, (deps.now ?? (() => new Date()))());
    if (!credentials.ok) throw new TikTokApiError({ kind: "reauth_required", path, httpStatus: null, code: null, requestId: null });
    return credentials.credentials.accessToken;
  };
}

// ---- Read model for the Integrasi page and the home banner ------------------------------------

export interface TikTokConnectionView {
  id: string;
  shopId: string;
  shopName: string | null;
  region: string | null;
  sellerType: string | null;
  status: TikTokConnectionStatus;
  grantedScopes: string[];
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
  connectedAt: Date;
  connectedByStaffUserId: string | null;
  lastRefreshedAt: Date | null;
  deauthorizedAt: Date | null;
  expiryWarningAt: Date | null;
  lastWebhookAt: Date | null;
  lastPollOkAt: Date | null;
  lastErrorCode: string | null;
  lastErrorAt: Date | null;
  /** The T5 kill switch: whether orders are applied to admin orders and stock. */
  ordersApplyEnabled: boolean;
  ordersApplyChangedAt: Date | null;
  /** "Sinkronkan stok ke TikTok" (docs/plans/tiktok-stock-sync.md, migration 0064). */
  stockSyncEnabled: boolean;
  stockSyncChangedAt: Date | null;
}

/** The current connection: the active or reauth-required one, else the most recently changed. No
 * token column is selected. */
export async function getTikTokConnectionView(db: Database): Promise<TikTokConnectionView | null> {
  const c = tiktokShopConnections;
  const [row] = await db
    .select({
      id: c.id,
      shopId: c.shopId,
      shopName: c.shopName,
      region: c.region,
      sellerType: c.sellerType,
      status: c.status,
      grantedScopes: c.grantedScopes,
      accessTokenExpiresAt: c.accessTokenExpiresAt,
      refreshTokenExpiresAt: c.refreshTokenExpiresAt,
      connectedAt: c.connectedAt,
      connectedByStaffUserId: c.connectedByStaffUserId,
      lastRefreshedAt: c.lastRefreshedAt,
      deauthorizedAt: c.deauthorizedAt,
      expiryWarningAt: c.expiryWarningAt,
      lastWebhookAt: c.lastWebhookAt,
      lastPollOkAt: c.lastPollOkAt,
      lastErrorCode: c.lastErrorCode,
      lastErrorAt: c.lastErrorAt,
      ordersApplyEnabled: c.ordersApplyEnabled,
      ordersApplyChangedAt: c.ordersApplyChangedAt,
      stockSyncEnabled: c.stockSyncEnabled,
      stockSyncChangedAt: c.stockSyncChangedAt,
    })
    .from(c)
    .orderBy(sql`case when ${c.status} in ('active', 'reauth_required') then 0 else 1 end`, desc(c.updatedAt))
    .limit(1);
  return row ?? null;
}
