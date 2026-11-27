// Pure rules for the TikTok Shop connection (docs/plans/tiktok-shop-integration.md §7.3): when a
// token is refreshed, and which banner the admin home and the Integrasi page show. No database, no
// clock of their own: callers pass `now`.

import type { TikTokConnectionStatus } from "@ammari/db/schema";

/** Refresh when the access token (7 days) has less than this left (§7.3 step 4). */
export const TIKTOK_REFRESH_WHEN_LEFT_MS = 24 * 60 * 60 * 1000;

/** "Hubungkan ulang sebelum ..." once the refresh token has this little left. TikTok's topic 7
 * (UPCOMING_AUTHORIZATION_EXPIRATION) shows the same banner whatever is left. */
export const TIKTOK_REAUTH_WARNING_MS = 7 * 24 * 60 * 60 * 1000;

/** OAuth state lifetime (§3.1: +10 min). */
export const TIKTOK_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export function tiktokRefreshDue(accessTokenExpiresAt: Date | null, now: Date): boolean {
  return accessTokenExpiresAt === null || accessTokenExpiresAt.getTime() - now.getTime() < TIKTOK_REFRESH_WHEN_LEFT_MS;
}

export interface TikTokBannerInput {
  status: TikTokConnectionStatus;
  refreshTokenExpiresAt: Date | null;
  expiryWarningAt: Date | null;
}

export type TikTokBanner =
  /** Topic 6: the seller revoked the app. Sync is stopped and the tokens are wiped. */
  | { kind: "deauthorized"; tone: "danger" }
  /** The tokens can no longer be used (refresh token expired or refused, or undecryptable). */
  | { kind: "reauth_required"; tone: "danger" }
  /** Still working, but the authorization ends soon: reconnect before `deadline`. */
  | { kind: "expiring"; tone: "warning"; deadline: Date | null };

/** Null when nothing needs attention (never connected, disconnected on purpose, or healthy). */
export function tiktokConnectionBanner(connection: TikTokBannerInput | null, now: Date): TikTokBanner | null {
  if (!connection) return null;
  switch (connection.status) {
    case "disconnected":
      return null;
    case "deauthorized":
      return { kind: "deauthorized", tone: "danger" };
    case "reauth_required":
      return { kind: "reauth_required", tone: "danger" };
    case "active": {
      const deadline = connection.refreshTokenExpiresAt;
      if (deadline && deadline.getTime() <= now.getTime()) return { kind: "reauth_required", tone: "danger" };
      const soon = deadline !== null && deadline.getTime() - now.getTime() <= TIKTOK_REAUTH_WARNING_MS;
      return soon || connection.expiryWarningAt !== null ? { kind: "expiring", tone: "warning", deadline } : null;
    }
  }
}
