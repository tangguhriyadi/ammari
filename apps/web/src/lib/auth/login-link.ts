import "server-only";
import { db } from "@ammari/db";
import { findLiveCustomerLoginLink, type LiveLoginLink } from "@ammari/auth/customer";
import { recordClaimAttemptAndCount } from "@/lib/claim/throttle";
import { getCartClientIp } from "@/lib/cart/ip";

// The "Masuk ke akun" confirm page (docs/plans/cart-checkout.md §9.3, session 14). Opening it only
// reads: the login is the page's own form POST to the customer auth instance's
// `/order-login-link/consume` (@ammari/auth's orderLoginLink plugin), so mail scanners and link
// prefetchers that open the URL never log anyone in.

export { LOGIN_LINK_CONSUME_ACTION, LOGIN_LINK_PAGE_PATH, LOGIN_LINK_SUCCESS_PATH } from "./login-link-paths";

/** Page opens per IP (plan §3 `login_link_view`): generous for a real buyer, a brake on probing. */
const VIEW_WINDOW_SECONDS = 10 * 60;
const VIEW_LIMIT = 60;

/** What the page shows. `status` values come back from the plugin's redirects (`invalid`, `error`)
 * and from the auth route's mapping of a refused POST (`limited`, `blocked`). */
const STATUSES = ["invalid", "limited", "blocked", "error"] as const;
type LoginLinkStatus = (typeof STATUSES)[number];

export type LoginLinkPageState = { kind: "confirm"; link: LiveLoginLink; token: string } | { kind: LoginLinkStatus };

function isStatus(value: string | undefined): value is LoginLinkStatus {
  return (STATUSES as readonly (string | undefined)[]).includes(value);
}

export async function loadLoginLinkPageState(params: { token?: string | string[]; status?: string | string[] }): Promise<LoginLinkPageState> {
  const status = Array.isArray(params.status) ? params.status[0] : params.status;
  if (isStatus(status)) return { kind: status };

  const token = Array.isArray(params.token) ? params.token[0] : params.token;
  if (!token) return { kind: "invalid" };

  const ip = await getCartClientIp("login link view");
  if (!ip) {
    // Production without CF-Connecting-IP: a proxy misconfiguration, so every link opens to an error.
    console.error("[login-link] confirm page refused: no client IP (check CF-Connecting-IP forwarding)");
    return { kind: "error" };
  }
  const prior = await recordClaimAttemptAndCount(db, ip, "login_link_view", VIEW_WINDOW_SECONDS);
  if (prior >= VIEW_LIMIT) return { kind: "limited" };

  const link = await findLiveCustomerLoginLink(db, token);
  return link ? { kind: "confirm", link, token } : { kind: "invalid" };
}
